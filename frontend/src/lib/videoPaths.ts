/** Parse video_path field which can be a JSON array or a single path string. */
export function parseVideoPaths(videoPath: string): string[] {
  if (!videoPath) return [];
  // Try JSON array first (new format)
  if (videoPath.startsWith('[')) {
    try {
      const arr = JSON.parse(videoPath);
      if (Array.isArray(arr)) return arr.filter(Boolean);
    } catch {}
  }
  // Legacy single path
  return [videoPath];
}

export function videoSrc(path: string): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  return `/localfile/${normalized}`;
}
