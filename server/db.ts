import { CONFIG } from "./config";
import { createStore, describeStore } from "./store";

/**
 * The one store instance the server uses.
 *
 * Set REDIS_URL and this is Redis; leave it unset and it is in-process. The
 * rest of the server never knows which, which is the point — the only file
 * that should care about where state lives is this one.
 */
export const store = createStore(CONFIG.REDIS_URL);
export const storeDescription = describeStore(CONFIG.REDIS_URL);
