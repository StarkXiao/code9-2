import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { requireActiveWriter, requireAuth, optionalAuth } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rateLimit";
import {
  appealSchema,
  confirmSchema,
  createSpotSchema,
  listSpotsQuerySchema,
  mySpotsQuerySchema,
  updateSpotSchema,
  uuidParamSchema,
} from "./schemas";
import {
  appealSpot,
  confirmSpot,
  createDraft,
  deleteSpot,
  getSpotByUuid,
  listMyFavorites,
  listMySpots,
  listRevisions,
  listSpots,
  setFavorite,
  submitForReview,
  updateSpot,
  withdrawSubmission,
} from "./service";

export const spotsRouter = Router();
export const meRouter = Router();

const writeLimiter = rateLimit({ scope: "spot-write", limit: 60, windowSeconds: 600 });
const submitLimiter = rateLimit({ scope: "spot-submit", limit: 30, windowSeconds: 3600 });

spotsRouter.get(
  "/spots",
  optionalAuth,
  validate({ query: listSpotsQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await listSpots(req.query as never, req.user);
    res.json(ok(req, result));
  }),
);

spotsRouter.get(
  "/spots/:uuid",
  optionalAuth,
  validate({ params: uuidParamSchema }),
  asyncHandler(async (req, res) => {
    const spot = await getSpotByUuid(req.params.uuid, req.user);
    res.json(ok(req, spot));
  }),
);

spotsRouter.post(
  "/spots",
  requireAuth,
  requireActiveWriter,
  writeLimiter,
  validate({ body: createSpotSchema }),
  asyncHandler(async (req, res) => {
    const spot = await createDraft(req.user!, req.body);
    res.status(201).json(ok(req, spot));
  }),
);

spotsRouter.patch(
  "/spots/:uuid",
  requireAuth,
  requireActiveWriter,
  writeLimiter,
  validate({ params: uuidParamSchema, body: updateSpotSchema }),
  asyncHandler(async (req, res) => {
    const result = await updateSpot(req.params.uuid, req.user!, req.body);
    res.json(ok(req, { ...result.spot, merge: result.merge }));
  }),
);

spotsRouter.delete(
  "/spots/:uuid",
  requireAuth,
  validate({ params: uuidParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await deleteSpot(req.params.uuid, req.user!);
    res.json(ok(req, result));
  }),
);

spotsRouter.post(
  "/spots/:uuid/submit",
  requireAuth,
  requireActiveWriter,
  submitLimiter,
  validate({ params: uuidParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await submitForReview(req.params.uuid, req.user!);
    res.status(result.autoCheck.passed ? 200 : 202).json(ok(req, result));
  }),
);

/**
 * 自动预检未通过时，用户可以要求人工复核。
 * 这是"用户认为系统误判"的出口，代价是信用分下降。
 */
spotsRouter.post(
  "/spots/:uuid/request-manual-review",
  requireAuth,
  requireActiveWriter,
  validate({ params: uuidParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await submitForReview(req.params.uuid, req.user!, { fromAutoRejected: true });
    res.json(ok(req, result));
  }),
);

spotsRouter.post(
  "/spots/:uuid/withdraw",
  requireAuth,
  validate({ params: uuidParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await withdrawSubmission(req.params.uuid, req.user!);
    res.json(ok(req, result));
  }),
);

spotsRouter.get(
  "/spots/:uuid/revisions",
  requireAuth,
  validate({ params: uuidParamSchema }),
  asyncHandler(async (req, res) => {
    const revisions = await listRevisions(req.params.uuid, req.user!);
    res.json(ok(req, { items: revisions }));
  }),
);

spotsRouter.post(
  "/spots/:uuid/confirm",
  requireAuth,
  requireActiveWriter,
  rateLimit({ scope: "spot-confirm", limit: 60, windowSeconds: 3600 }),
  validate({ params: uuidParamSchema, body: confirmSchema }),
  asyncHandler(async (req, res) => {
    const result = await confirmSpot(
      req.params.uuid,
      req.user!,
      req.body.isAccurate,
      req.body.note,
    );
    res.json(ok(req, result));
  }),
);

spotsRouter.post(
  "/spots/:uuid/favorite",
  requireAuth,
  validate({ params: uuidParamSchema }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await setFavorite(req.params.uuid, req.user!, true)));
  }),
);

spotsRouter.delete(
  "/spots/:uuid/favorite",
  requireAuth,
  validate({ params: uuidParamSchema }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await setFavorite(req.params.uuid, req.user!, false)));
  }),
);

spotsRouter.post(
  "/spots/:uuid/appeal",
  requireAuth,
  validate({ params: uuidParamSchema, body: appealSchema }),
  asyncHandler(async (req, res) => {
    const result = await appealSpot(req.params.uuid, req.user!, req.body.reason);
    res.status(201).json(ok(req, result));
  }),
);

meRouter.get(
  "/me/spots",
  requireAuth,
  validate({ query: mySpotsQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof mySpotsQuerySchema>;
    const result = await listMySpots(req.user!, query);
    res.json(ok(req, result));
  }),
);

meRouter.get(
  "/me/favorites",
  requireAuth,
  validate({ query: mySpotsQuerySchema.pick({ page: true, pageSize: true }) }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as { page: number; pageSize: number };
    const result = await listMyFavorites(req.user!, query);
    res.json(ok(req, result));
  }),
);
