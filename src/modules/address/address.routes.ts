import { Router } from "express";
import { requireAuth, validateBody } from "../../common/middleware";
import { createAddressSchema, updateAddressSchema } from "./address.validation";
import {
  listAddressesHandler,
  createAddressHandler,
  updateAddressHandler,
  deleteAddressHandler,
  setDefaultAddressHandler,
} from "./address.controller";

// A user's own address book — every route is scoped to req.userId inside the
// service, so there is no way to read or mutate another account's addresses
// even with a valid session and a guessed addressId.
const router = Router();

router.use(requireAuth);

router.get("/", listAddressesHandler);
router.post("/", validateBody(createAddressSchema), createAddressHandler);
router.patch("/:addressId", validateBody(updateAddressSchema), updateAddressHandler);
router.delete("/:addressId", deleteAddressHandler);
router.patch("/:addressId/default", setDefaultAddressHandler);

export default router;
