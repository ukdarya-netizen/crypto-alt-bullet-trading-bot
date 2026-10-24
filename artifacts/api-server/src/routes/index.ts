import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tradingRouter from "./trading";
import journalRouter from "./journal";
import historicalCascadeSelectionRouter from "./historical-cascade-selection";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tradingRouter);
router.use(journalRouter);
router.use(historicalCascadeSelectionRouter);

export default router;
