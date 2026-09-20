-- Fuel-farm throughput fees ride the dividend-credit table (same
-- settle-next-tick mechanics), distinguished by kind so the tick can book
-- them as operating income rather than dividends. Every existing row is a
-- dividend. See FUEL_OPERATIONS_PLAN.md §8.2.
ALTER TABLE "DividendCredit" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'dividend';
