// ccpro is used in Beijing and Singapore, both UTC+8 all year with no daylight
// saving, so times are read and shown in that one offset.
export const UTC8_OFFSET = 8 * 60 * 60 * 1000;
export const DAY = 24 * 60 * 60 * 1000;

// A Date whose UTC fields hold the wall-clock time in UTC+8.
export const wallClock = (instant) => new Date(instant + UTC8_OFFSET);

export const fromWallClock = (year, monthIndex, day, hour, minute) =>
  Date.UTC(year, monthIndex, day, hour, minute) - UTC8_OFFSET;
