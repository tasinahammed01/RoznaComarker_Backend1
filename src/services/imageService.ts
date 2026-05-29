// src/services/imageService.ts
// Fetches a topic-relevant illustration URL.
// Priority: Unsplash -> Pixabay -> placeholder
// Never throws. Always returns a usable image URL.

interface UnsplashSearchResponse {
  results: { urls: { regular: string } }[];
}

interface PixabaySearchResponse {
  hits: { webformatURL: string }[];
}

export async function fetchTopicImage(query: string): Promise<string> {
  const encodedQuery = encodeURIComponent(query);

  // --- Attempt 1: Unsplash ---
  try {
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodedQuery}&per_page=1&orientation=portrait`,
      {
        headers: {
          Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`,
        },
      }
    );

    if (res.ok) {
      const data = (await res.json()) as UnsplashSearchResponse;
      const url = data?.results?.[0]?.urls?.regular;
      if (url) return url;
    }
  } catch (err) {
    console.warn("[imageService] Unsplash failed:", err);
  }

  // --- Attempt 2: Pixabay ---
  try {
    const res = await fetch(
      `https://pixabay.com/api/?key=${process.env.PIXABAY_API_KEY}&q=${encodedQuery}&image_type=illustration&per_page=3&safesearch=true`
    );

    if (res.ok) {
      const data = (await res.json()) as PixabaySearchResponse;
      const url = data?.hits?.[0]?.webformatURL;
      if (url) return url;
    }
  } catch (err) {
    console.warn("[imageService] Pixabay failed:", err);
  }

  // --- Fallback: placeholder ---
  console.warn("[imageService] Both image APIs failed. Using placeholder.");
  return `https://placehold.co/300x400/e8f5e9/2d6a2d?text=${encodedQuery}`;
}
