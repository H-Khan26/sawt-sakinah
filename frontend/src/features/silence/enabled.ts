/**
 * Whether detected silences are drawn and clickable on the waveform. Off while `LowerBand` leaves
 * out the Silence tool, so nothing selects a silence that no panel can act on; restoring the tool
 * means turning this on and mounting `SilencePanel` there again.
 */
export const SILENCE_TOOL = false;
