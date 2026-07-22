/**
 * FP4 test device.
 *
 * A payment only moves if the account's registered device key signs its exact
 * terms. In the app that key is generated in the browser and gated behind the
 * passkey; in these scripts we play the device. Either way the server never
 * holds the private half — which is the whole point of the control.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export type ApiFn = (pathname: string, body?: any) => Promise<any>;
export type Device = ReturnType<typeof privateKeyToAccount>;

export function newDevice(): Device {
  return privateKeyToAccount(generatePrivateKey());
}

/** Sign the EIP-712 terms the API handed back, as a browser wallet would. */
export function signTerms(device: Device, typedData: any): Promise<`0x${string}`> {
  return device.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: {
      ...typedData.message,
      amount: BigInt(typedData.message.amount),
      deadline: BigInt(typedData.message.deadline),
    },
  });
}

/** Bind the account to this device key (trust-on-first-use at onboarding). */
export function registerDevice(api: ApiFn, userId: string, device: Device) {
  return api(`/api/users/${userId}/authorizer`, { address: device.address });
}

/** Create a transfer, sign its terms on the device, submit the signature. */
export async function sendTransfer(api: ApiFn, device: Device, body: any) {
  const created = await api("/api/transfers", body);
  const signature = await signTerms(device, created.authorization.typedData);
  return api(`/api/transfers/${created.id}/authorize`, { signature });
}
