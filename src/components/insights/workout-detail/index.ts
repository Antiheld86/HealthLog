/**
 * Barrel for the workout-detail surface (#67). The former single
 * `workout-detail.tsx` grew past a comfortable size once the HR curve,
 * zones, route SVG, splits and day context landed, so it was split into
 * this directory. Import path stays `@/components/insights/workout-detail`.
 */
export { WorkoutDetailHeader } from "./header";
export { WorkoutDetailStats } from "./stats";
export { WorkoutDetailHrSection } from "./hr-section";
export { WorkoutDetailZones } from "./zones";
export { WorkoutDetailRoute } from "./route-map";
export { WorkoutDetailSplits } from "./splits";
export { WorkoutDetailDayContext } from "./day-context";
export { WorkoutInsightCard } from "./insight-slot";
