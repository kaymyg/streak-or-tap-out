import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HDNodeWallet, Wallet } from "ethers";
import { DailyTap, StreakToken } from "../typechain-types";

const DAY = 86400n;
const E18 = 10n ** 18n;
const REF_AVG = 35n; // matches the server's REF_AVG

/**
 * These tests exist because reading a contract is a worse bug detector than
 * running one. Each block below pins one claim the design depends on. If a
 * future change breaks one of these, the test says which claim died.
 */
describe("DailyTap", () => {
  let token: StreakToken;
  let tap: DailyTap;
  let verifier: HDNodeWallet | Wallet;
  let owner: any, alice: any, bob: any;
  let chainId: bigint;

  /** EIP-712 signature over a tap session, exactly as the server produces it. */
  async function signTap(
    signer: HDNodeWallet | Wallet,
    player: string,
    tapCount: bigint,
    day: bigint,
    avg: bigint = REF_AVG
  ) {
    const domain = {
      name: "DailyTap",
      version: "1",
      chainId,
      verifyingContract: await tap.getAddress(),
    };
    const types = {
      Tap: [
        { name: "player", type: "address" },
        { name: "tapCount", type: "uint256" },
        { name: "day", type: "uint256" },
        { name: "avgTapCount", type: "uint256" },
      ],
    };
    return signer.signTypedData(domain, types, {
      player,
      tapCount,
      day,
      avgTapCount: avg,
    });
  }

  /** Move the chain into the middle of `day`, so the next tx is safely inside it. */
  async function travelToDay(day: bigint) {
    await time.increaseTo(Number(day * DAY + 3600n));
  }

  /** Convenience: sign for today and submit as `who`. */
  async function tapAs(who: any, tapCount: bigint, avg: bigint = REF_AVG) {
    const day = await tap.currentDay();
    const sig = await signTap(verifier, who.address, tapCount, day, avg);
    return tap.connect(who).tap(tapCount, day, avg, sig);
  }

  beforeEach(async () => {
    [owner, alice, bob] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    // The verifier key is a plain EOA that never holds funds and never sends
    // transactions — it only signs typed data off-chain.
    verifier = ethers.Wallet.createRandom();

    token = (await (
      await ethers.getContractFactory("StreakToken")
    ).deploy()) as unknown as StreakToken;

    tap = (await (
      await ethers.getContractFactory("DailyTap")
    ).deploy(await token.getAddress(), verifier.address)) as unknown as DailyTap;

    await token.grantRole(await token.MINTER_ROLE(), await tap.getAddress());
  });

  describe("streak rollover", () => {
    it("first ever tap starts the streak at 1, not 0", async () => {
      await tapAs(alice, REF_AVG);
      expect(await tap.streakOf(alice.address)).to.equal(1n);
    });

    it("tapping on consecutive days increments the streak", async () => {
      await tapAs(alice, REF_AVG);
      const d = await tap.currentDay();

      await travelToDay(d + 1n);
      await tapAs(alice, REF_AVG);
      expect(await tap.streakOf(alice.address)).to.equal(2n);

      await travelToDay(d + 2n);
      await tapAs(alice, REF_AVG);
      expect(await tap.streakOf(alice.address)).to.equal(3n);
    });

    it("missing a day resets the streak to 1, NOT 0 (the player is tapping today)", async () => {
      await tapAs(alice, REF_AVG);
      const d = await tap.currentDay();

      await travelToDay(d + 1n);
      await tapAs(alice, REF_AVG);
      expect(await tap.streakOf(alice.address)).to.equal(2n);

      // skip day d+2 entirely
      await travelToDay(d + 3n);
      await tapAs(alice, REF_AVG);
      expect(await tap.streakOf(alice.address)).to.equal(1n);
    });

    it("projectedStreak matches what tap() actually does", async () => {
      expect(await tap.projectedStreak(alice.address)).to.equal(1n);
      await tapAs(alice, REF_AVG);

      // already tapped today -> projection is the current streak
      expect(await tap.projectedStreak(alice.address)).to.equal(1n);

      const d = await tap.currentDay();
      await travelToDay(d + 1n);
      expect(await tap.projectedStreak(alice.address)).to.equal(2n);
      await tapAs(alice, REF_AVG);
      expect(await tap.streakOf(alice.address)).to.equal(2n);

      await travelToDay(d + 5n); // broke the streak
      expect(await tap.projectedStreak(alice.address)).to.equal(1n);
    });
  });

  describe("replay protection", () => {
    it("a second tap on the same day reverts", async () => {
      await tapAs(alice, REF_AVG);
      await expect(tapAs(alice, REF_AVG)).to.be.revertedWithCustomError(
        tap,
        "AlreadyTappedToday"
      );
    });

    it("replaying yesterday's signature tomorrow reverts on the day check", async () => {
      const d = await tap.currentDay();
      const sig = await signTap(verifier, alice.address, REF_AVG, d);
      await tap.connect(alice).tap(REF_AVG, d, REF_AVG, sig);

      await travelToDay(d + 1n);
      await expect(
        tap.connect(alice).tap(REF_AVG, d, REF_AVG, sig)
      ).to.be.revertedWithCustomError(tap, "WrongDay");
    });

    it("a signature issued for one wallet cannot be submitted by another", async () => {
      const day = await tap.currentDay();
      const sigForAlice = await signTap(verifier, alice.address, REF_AVG, day);

      // Bob intercepts it and tries to use it. The digest is built from
      // msg.sender, so recovery yields the wrong signer.
      await expect(
        tap.connect(bob).tap(REF_AVG, day, REF_AVG, sigForAlice)
      ).to.be.revertedWithCustomError(tap, "BadSignature");
    });

    it("a signature for a FUTURE day cannot be pre-submitted", async () => {
      const day = await tap.currentDay();
      const sig = await signTap(verifier, alice.address, REF_AVG, day + 1n);
      await expect(
        tap.connect(alice).tap(REF_AVG, day + 1n, REF_AVG, sig)
      ).to.be.revertedWithCustomError(tap, "WrongDay");
    });
  });

  describe("signature authority", () => {
    it("a signature from any key other than the verifier reverts", async () => {
      const impostor = ethers.Wallet.createRandom();
      const day = await tap.currentDay();
      const sig = await signTap(impostor, alice.address, REF_AVG, day);
      await expect(
        tap.connect(alice).tap(REF_AVG, day, REF_AVG, sig)
      ).to.be.revertedWithCustomError(tap, "BadSignature");
    });

    it("tampering with tapCount after signing invalidates the signature", async () => {
      const day = await tap.currentDay();
      const sig = await signTap(verifier, alice.address, 30n, day);
      // player submits a bigger number than was signed
      await expect(
        tap.connect(alice).tap(90n, day, REF_AVG, sig)
      ).to.be.revertedWithCustomError(tap, "BadSignature");
    });

    it("tampering with avgTapCount to inflate the reward invalidates the signature", async () => {
      const day = await tap.currentDay();
      const sig = await signTap(verifier, alice.address, REF_AVG, day, REF_AVG);
      // shrinking the denominator would multiply the payout
      await expect(
        tap.connect(alice).tap(REF_AVG, day, 1n, sig)
      ).to.be.revertedWithCustomError(tap, "BadSignature");
    });
  });

  describe("input bounds", () => {
    it("rejects a zero tapCount", async () => {
      const day = await tap.currentDay();
      const sig = await signTap(verifier, alice.address, 0n, day);
      await expect(
        tap.connect(alice).tap(0n, day, REF_AVG, sig)
      ).to.be.revertedWithCustomError(tap, "TapCountOutOfRange");
    });

    it("rejects a tapCount above MAX_TAPS even with a valid signature", async () => {
      const day = await tap.currentDay();
      const over = (await tap.MAX_TAPS()) + 1n;
      const sig = await signTap(verifier, alice.address, over, day);
      await expect(
        tap.connect(alice).tap(over, day, REF_AVG, sig)
      ).to.be.revertedWithCustomError(tap, "TapCountOutOfRange");
    });

    it("rejects a zero average (would divide by zero)", async () => {
      const day = await tap.currentDay();
      const sig = await signTap(verifier, alice.address, REF_AVG, day, 0n);
      await expect(
        tap.connect(alice).tap(REF_AVG, day, 0n, sig)
      ).to.be.revertedWithCustomError(tap, "BadAverage");
    });
  });

  describe("reward maths", () => {
    it("an average run on day 1 pays BASE * 1.1", async () => {
      expect(await tap.previewReward(1n, REF_AVG, REF_AVG)).to.equal(11n * E18);
    });

    it("the streak multiplier caps at 4.0x on day 30 and never grows after", async () => {
      expect(await tap.previewReward(30n, REF_AVG, REF_AVG)).to.equal(40n * E18);
      expect(await tap.previewReward(31n, REF_AVG, REF_AVG)).to.equal(40n * E18);
      expect(await tap.previewReward(5000n, REF_AVG, REF_AVG)).to.equal(40n * E18);
    });

    it("the performance multiplier caps at 2.0x when the average collapses", async () => {
      // avg of 5 with a 100-tap run would be 20x uncapped
      expect(await tap.previewReward(1n, 100n, 5n)).to.equal(22n * E18); // 10 * 1.1 * 2.0
    });

    it("the absolute per-day ceiling is 80 STREAK", async () => {
      const maxTaps = await tap.MAX_TAPS();
      expect(await tap.previewReward(30n, maxTaps, 1n)).to.equal(80n * E18);
    });

    it("actually mints the previewed amount", async () => {
      const expected = await tap.previewReward(1n, REF_AVG, REF_AVG);
      await tapAs(alice, REF_AVG);
      expect(await token.balanceOf(alice.address)).to.equal(expected);
    });

    it("emits Tapped with the post-increment streak", async () => {
      const day = await tap.currentDay();
      await expect(tapAs(alice, REF_AVG))
        .to.emit(tap, "Tapped")
        .withArgs(alice.address, day, REF_AVG, 1n, 11n * E18);
    });
  });

  describe("verifier rotation", () => {
    it("only the owner can rotate the verifier", async () => {
      await expect(
        tap.connect(alice).setVerifier(alice.address)
      ).to.be.revertedWithCustomError(tap, "OwnableUnauthorizedAccount");
    });

    it("refuses the zero address", async () => {
      await expect(
        tap.setVerifier(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(tap, "ZeroVerifier");
    });

    it("after rotation, old-key signatures fail and new-key signatures work", async () => {
      const next = ethers.Wallet.createRandom();
      await expect(tap.setVerifier(next.address))
        .to.emit(tap, "VerifierSet")
        .withArgs(verifier.address, next.address);

      const day = await tap.currentDay();

      const oldSig = await signTap(verifier, alice.address, REF_AVG, day);
      await expect(
        tap.connect(alice).tap(REF_AVG, day, REF_AVG, oldSig)
      ).to.be.revertedWithCustomError(tap, "BadSignature");

      const newSig = await signTap(next, alice.address, REF_AVG, day);
      await expect(tap.connect(alice).tap(REF_AVG, day, REF_AVG, newSig)).to.not.be
        .reverted;
    });
  });

  describe("minting authority", () => {
    it("DailyTap holds MINTER_ROLE and nobody else does", async () => {
      const role = await token.MINTER_ROLE();
      expect(await token.hasRole(role, await tap.getAddress())).to.equal(true);
      expect(await token.hasRole(role, owner.address)).to.equal(false);
      expect(await token.hasRole(role, alice.address)).to.equal(false);
    });

    it("a direct mint from a non-minter reverts", async () => {
      await expect(
        token.connect(alice).mint(alice.address, 1n)
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("tap() reverts once the cap is reached rather than minting past it", async () => {
      // Deploy a scenario where the cap is already consumed: grant the owner
      // the minter role temporarily and mint the whole supply.
      await token.grantRole(await token.MINTER_ROLE(), owner.address);
      await token.mint(owner.address, await token.MAX_SUPPLY());

      await expect(tapAs(alice, REF_AVG)).to.be.revertedWithCustomError(
        token,
        "CapExceeded"
      );
    });
  });
});
