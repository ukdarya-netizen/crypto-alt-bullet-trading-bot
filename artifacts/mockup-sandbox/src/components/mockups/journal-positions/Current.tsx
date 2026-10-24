import { JournalPositions } from "./_JournalPositions";

export function Current() {
  const requestedMode = new URLSearchParams(window.location.search).get("mode");
  const mode = requestedMode === "real" || requestedMode === "vst" ? requestedMode : "paper";
  return <main className="min-h-screen px-4 py-5 sm:px-6"><JournalPositions mode={mode} /></main>;
}

export default Current;