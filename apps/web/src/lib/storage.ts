import { get, set } from "idb-keyval";

export interface StoredDeviceIdentity {
  deviceId: string;
  label: string;
  privateKey: string;
  publicKey: string;
  createdAt: string;
}

const STORAGE_KEY = "simplechat_device_identity";
const AUTH_TOKEN_STORAGE_KEY = "simplechat_session_token";

export const loadStoredDeviceIdentity = async (): Promise<StoredDeviceIdentity | null> => {
  return (await get<StoredDeviceIdentity>(STORAGE_KEY)) ?? null;
};

export const saveStoredDeviceIdentity = async (
  identity: StoredDeviceIdentity
): Promise<void> => {
  await set(STORAGE_KEY, identity);
};

export const loadStoredSessionToken = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
};

export const saveStoredSessionToken = (token: string | null): void => {
  if (typeof window === "undefined") {
    return;
  }

  if (token) {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    return;
  }

  window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};
