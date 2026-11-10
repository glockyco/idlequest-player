// The guard's notes in the event log (`guardNote` in src/bridge.js) that the analysis tools read.

/** The start of an escape, with its trigger and the guard's detail: "[guard] leaving: <trigger>: <detail>". */
export const ESCAPE_START = /^\[guard\] leaving: (\w+)(?:: (.*))?$/;

/**
 * The end of an escape. The guard notes "escape done" once it is back in a zone. Logs from before
 * the bot started AutoLevel after an escape end with the guard's own restart line instead.
 */
export const ESCAPE_END = /^\[guard\] (?:escape done|AutoLevel (?:running again|did NOT restart))/;
