import { Request, Response } from "express";
import { asyncHandler } from "../../common/utils/asyncHandler";
import * as addressService from "./address.service";
import type { CreateAddressInput, UpdateAddressInput } from "./address.validation";

export const listAddressesHandler = asyncHandler(async (req: Request, res: Response) => {
  const items = await addressService.listAddresses(req.userId!);
  res.status(200).json({ success: true, data: { items, total: items.length } });
});

export const createAddressHandler = asyncHandler(async (req: Request, res: Response) => {
  const address = await addressService.createAddress(req.userId!, req.body as CreateAddressInput);
  res.status(201).json({ success: true, message: "Address added", data: { address } });
});

export const updateAddressHandler = asyncHandler(async (req: Request, res: Response) => {
  const address = await addressService.updateAddress(
    req.userId!,
    String(req.params.addressId),
    req.body as UpdateAddressInput
  );
  res.status(200).json({ success: true, message: "Address updated", data: { address } });
});

export const deleteAddressHandler = asyncHandler(async (req: Request, res: Response) => {
  await addressService.deleteAddress(req.userId!, String(req.params.addressId));
  res.status(200).json({ success: true, message: "Address removed", data: { deleted: true } });
});

export const setDefaultAddressHandler = asyncHandler(async (req: Request, res: Response) => {
  const address = await addressService.setDefaultAddress(req.userId!, String(req.params.addressId));
  res.status(200).json({ success: true, message: "Default address updated", data: { address } });
});
