import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tradingRouter from "./trading";
import journalRouter from "./journal";
import historicalCascadeSelectionRouter from "./historical-cascade-selection";
import subscribersRouter from "./subscribers";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tradingRouter);
router.use(subscribersRouter);
router.use(journalRouter);
router.use(historicalCascadeSelectionRouter);

export default router;
