import { get, set } from "idb-keyval";

export interface StoredDeviceIdentity {
  deviceId: string;
  label: string;
  privateKey: string;
  publicKey: string;
  createdAt: string;
}

const STORAGE_KEY = "simplechat_device_identity";

export const loadStoredDeviceIdentity = async (): Promise<StoredDeviceIdentity | null> => {
  return (await get<StoredDeviceIdentity>(STORAGE_KEY)) ?? null;
};

export const saveStoredDeviceIdentity = async (
  identity: StoredDeviceIdentity
): Promise<void> => {
  await set(STORAGE_KEY, identity);
};
