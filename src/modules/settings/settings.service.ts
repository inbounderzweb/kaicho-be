import mongoose from "mongoose";
import {
  StoreSettings,
  StoreSettingsDocument,
  STORE_SETTINGS_DEFAULTS,
  PackRecommendationStrategy,
} from "../../database/models";
import { AppError } from "../../common/errors";
import type { UpdateStoreSettingsInput } from "./settings.validation";

export interface StoreSettingsDto {
  freeShippingThreshold: number;
  flatShippingFee: number;
  defaultPackRecommendationStrategy: PackRecommendationStrategy;
  showMrp: boolean;
  restrictDeliveryToStates: boolean;
  serviceableStates: string[];
  updatedAt: string;
}

// The one settings document, created on first access with the shipped
// defaults. upsert + $setOnInsert make this race-safe: two concurrent
// first-hits can't create two docs (the unique `key` index), and the loser
// just gets the winner's. returnDocument "after" means it's never null.
export async function getStoreSettingsDoc(): Promise<StoreSettingsDocument> {
  const doc = await StoreSettings.findOneAndUpdate(
    { key: "store" },
    { $setOnInsert: { key: "store", ...STORE_SETTINGS_DEFAULTS } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).exec();
  return doc as StoreSettingsDocument;
}

export function toStoreSettingsDto(doc: StoreSettingsDocument): StoreSettingsDto {
  return {
    freeShippingThreshold: doc.freeShippingThreshold,
    flatShippingFee: doc.flatShippingFee,
    defaultPackRecommendationStrategy: doc.defaultPackRecommendationStrategy,
    showMrp: doc.showMrp !== false,
    restrictDeliveryToStates: doc.restrictDeliveryToStates === true,
    serviceableStates: [...(doc.serviceableStates ?? [])],
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function getStoreSettings(): Promise<StoreSettingsDto> {
  return toStoreSettingsDto(await getStoreSettingsDoc());
}

export async function updateStoreSettings(
  patch: UpdateStoreSettingsInput,
  userId?: string
): Promise<StoreSettingsDto> {
  const doc = await getStoreSettingsDoc();
  if (patch.freeShippingThreshold !== undefined) {
    doc.freeShippingThreshold = patch.freeShippingThreshold;
  }
  if (patch.flatShippingFee !== undefined) {
    doc.flatShippingFee = patch.flatShippingFee;
  }
  if (patch.defaultPackRecommendationStrategy !== undefined) {
    doc.defaultPackRecommendationStrategy = patch.defaultPackRecommendationStrategy;
  }
  if (patch.showMrp !== undefined) {
    doc.showMrp = patch.showMrp;
  }
  if (patch.restrictDeliveryToStates !== undefined) {
    doc.restrictDeliveryToStates = patch.restrictDeliveryToStates;
  }
  if (patch.serviceableStates !== undefined) {
    doc.serviceableStates = patch.serviceableStates;
  }
  // Checked against the document as it WILL look, so turning the restriction
  // on without any state (or clearing the list while it is on) can't lock
  // every customer out.
  if (doc.restrictDeliveryToStates && (doc.serviceableStates?.length ?? 0) === 0) {
    throw new AppError("Select at least one state, or turn the restriction off", 400);
  }
  if (userId) {
    doc.updatedBy = new mongoose.Types.ObjectId(userId);
  }
  await doc.save();
  return toStoreSettingsDto(doc);
}

// Narrow read for the checkout money math — just the shipping policy, none of
// the metadata. Falls back to the shipped defaults if the doc somehow can't
// be materialised, so a settings hiccup can never block a checkout.
export async function getShippingPolicy(): Promise<{
  freeShippingThreshold: number;
  flatShippingFee: number;
}> {
  try {
    const doc = await getStoreSettingsDoc();
    return {
      freeShippingThreshold: doc.freeShippingThreshold,
      flatShippingFee: doc.flatShippingFee,
    };
  } catch {
    return { ...STORE_SETTINGS_DEFAULTS };
  }
}

// Narrow read for pack-combination resolution's outermost "Global" tier —
// mirrors getShippingPolicy()'s shape and its fail-safe fallback so a
// settings hiccup can never block a pack recommendation.
export async function getDefaultPackRecommendationStrategy(): Promise<PackRecommendationStrategy> {
  try {
    const doc = await getStoreSettingsDoc();
    return doc.defaultPackRecommendationStrategy;
  } catch {
    return STORE_SETTINGS_DEFAULTS.defaultPackRecommendationStrategy;
  }
}
