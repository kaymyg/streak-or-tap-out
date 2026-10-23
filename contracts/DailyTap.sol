// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {StreakToken} from "./StreakToken.sol";

/// @title DailyTap
/// @notice One verifier-signed tap session per wallet per UTC day.
///
/// SECURITY MODEL — read this before changing anything.
///
/// This contract cannot verify that a player actually tapped. It can only
/// verify that the verifier server SAID they did. Every anti-cheat guarantee
/// lives in the server's checks before it signs; the signature is the server's
/// assertion, not proof of play. What the contract adds on top is narrow and
/// worth stating exactly:
///
///   1. The signature is bound to `msg.sender`, so a captured signature cannot
///      be submitted by a different wallet.
///   2. The signature is bound to `day`, and `day` must be today, so a captured
///      signature is worthless after midnight UTC.
///   3. `lastDay[player] < day` allows at most one successful tap per wallet per
///      day, so a signature cannot be replayed even within its own day.
///
/// Together (2) and (3) are a complete replay guard. A per-wallet nonce would
/// add a storage write and an RPC round-trip and stop nothing these don't.
contract DailyTap is EIP712, Ownable {
    StreakToken public immutable streak;
    address public verifier;

    uint256 public constant DAY = 1 days;
    uint256 public constant BASE_REWARD = 10e18;

    /// @dev Sanity bound only. The server will not sign more than ~65 (13
    ///      taps/sec over a 5s window), so this never binds in normal play. It
    ///      exists so a compromised verifier key cannot mint an absurd amount
    ///      in a single call.
    uint256 public constant MAX_TAPS = 100;

    /// @dev Streak multiplier caps at day 30. Note the floor is 1.1x, not 1.0x:
    ///      a first-ever tap sets streakOf = 1, so nobody ever sees 1.0x.
    uint256 public constant MAX_STREAK = 30;

    /// @dev Guard against a depressed rolling average. With a static
    ///      avgTapCount this never binds, but once the server feeds a 7-day
    ///      rolling average it can: if the average collapses, this stops the
    ///      performance factor running away. 2e18 == 2.0x.
    uint256 public constant MAX_PERF = 2e18;

    mapping(address => uint256) public lastDay;
    mapping(address => uint256) public streakOf;

    bytes32 private constant TAP_TYPEHASH = keccak256(
        "Tap(address player,uint256 tapCount,uint256 day,uint256 avgTapCount)"
    );

    event Tapped(
        address indexed player,
        uint256 indexed day,
        uint256 tapCount,
        uint256 streak,
        uint256 reward
    );
    event VerifierSet(address indexed previous, address indexed next);

    error WrongDay(uint256 provided, uint256 current);
    error AlreadyTappedToday(uint256 lastDay);
    error TapCountOutOfRange(uint256 tapCount);
    error BadAverage();
    error BadSignature();
    error ZeroVerifier();

    constructor(StreakToken _streak, address _verifier)
        EIP712("DailyTap", "1")
        Ownable(msg.sender)
    {
        if (_verifier == address(0)) revert ZeroVerifier();
        streak = _streak;
        verifier = _verifier;
        emit VerifierSet(address(0), _verifier);
    }

    /// @notice Rotate the verifier key.
    /// @dev The verifier key lives hot on a web server, which makes it the most
    ///      likely thing in this system to leak. Without this function the only
    ///      remedy would be redeploying and abandoning every player's streak.
    ///      For mainnet, put this behind a timelock or two-step handoff: an
    ///      owner who can rotate instantly is also an owner who can rotate
    ///      maliciously.
    function setVerifier(address next) external onlyOwner {
        if (next == address(0)) revert ZeroVerifier();
        emit VerifierSet(verifier, next);
        verifier = next;
    }

    function currentDay() public view returns (uint256) {
        return block.timestamp / DAY;
    }

    /// @notice Preview what a wallet's streak would become if it tapped now.
    /// @dev The UI uses this so it never has to reimplement the rollover rule.
    function projectedStreak(address player) external view returns (uint256) {
        uint256 day = currentDay();
        if (lastDay[player] >= day) return streakOf[player]; // already tapped
        return lastDay[player] == day - 1 ? streakOf[player] + 1 : 1;
    }

    function tap(
        uint256 tapCount,
        uint256 day,
        uint256 avgTapCount,
        bytes calldata sig
    ) external {
        uint256 today = currentDay();
        if (day != today) revert WrongDay(day, today);
        if (lastDay[msg.sender] >= day) revert AlreadyTappedToday(lastDay[msg.sender]);
        if (tapCount == 0 || tapCount > MAX_TAPS) revert TapCountOutOfRange(tapCount);
        if (avgTapCount == 0) revert BadAverage();

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(TAP_TYPEHASH, msg.sender, tapCount, day, avgTapCount))
        );
        if (ECDSA.recover(digest, sig) != verifier) revert BadSignature();

        // Continue the streak only if the last tap was yesterday. Otherwise
        // this tap starts a new streak at 1 — the player IS tapping today, so
        // resetting to 0 would show "Day 0" and pay a 1.0x multiplier that the
        // rest of the system never produces.
        if (lastDay[msg.sender] == day - 1) {
            streakOf[msg.sender] += 1;
        } else {
            streakOf[msg.sender] = 1;
        }
        lastDay[msg.sender] = day;

        uint256 reward = _reward(streakOf[msg.sender], tapCount, avgTapCount);
        streak.mint(msg.sender, reward);
        emit Tapped(msg.sender, day, tapCount, streakOf[msg.sender], reward);
    }

    /// @notice reward = BASE * streakMult * perf
    ///         streakMult = 1.0 + 0.1 * min(streak, 30)  -> 1.1x .. 4.0x
    ///         perf       = tapCount / avgTapCount, capped at MAX_PERF
    function _reward(uint256 s, uint256 tapCount, uint256 avg)
        internal
        pure
        returns (uint256)
    {
        uint256 cappedStreak = s > MAX_STREAK ? MAX_STREAK : s;
        uint256 multBps = 10_000 + 1_000 * cappedStreak;

        uint256 perf = (tapCount * 1e18) / avg;
        if (perf > MAX_PERF) perf = MAX_PERF;

        return (BASE_REWARD * multBps * perf) / (10_000 * 1e18);
    }

    /// @dev Exposed so tests and the UI can check reward math without
    ///      simulating a full tap.
    function previewReward(uint256 s, uint256 tapCount, uint256 avg)
        external
        pure
        returns (uint256)
    {
        return _reward(s, tapCount, avg);
    }
}
