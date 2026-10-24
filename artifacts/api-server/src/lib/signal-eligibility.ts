type SignalClassification = {
  confirmationStatus: "candidate" | "confirmed";
  patternStatus: "approved" | "experimental";
  patternId: string;
};

export function approvedPatternIds(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

export function signalEligibility(
  signal: SignalClassification,
  allowlist: Set<string>,
): "CONFIRMED_SIGNAL_REQUIRED" | "EXPERIMENTAL_PATTERN" | "PATTERN_NOT_APPROVED" | null {
  if (signal.confirmationStatus !== "confirmed") return "CONFIRMED_SIGNAL_REQUIRED";
  if (signal.patternStatus !== "approved") return "EXPERIMENTAL_PATTERN";
  if (!allowlist.has(signal.patternId)) return "PATTERN_NOT_APPROVED";
  return null;
}