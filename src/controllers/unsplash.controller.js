const logger = require("../utils/logger");

/**
 * Search Unsplash for images
 * GET /api/unsplash/search?q=:keyword&per_page=:n
 *
 * Returns ONLY small (~400 px) URLs — no image downloading, no processing.
 * The browser renders them directly from Unsplash CDN.
 */
async function searchUnsplashImages(req, res) {
  const t0 = Date.now();

  try {
    const { q, per_page } = req.query;

    if (!q || !String(q).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Search query parameter "q" is required',
      });
    }

    const unsplashAccessKey = process.env.UNSPLASH_ACCESS_KEY;
    if (!unsplashAccessKey) {
      logger.error("[UNSPLASH] UNSPLASH_ACCESS_KEY not configured");
      return res.status(500).json({
        success: false,
        message: "Unsplash access key not configured",
      });
    }

    const perPage = Math.min(Math.max(parseInt(per_page, 10) || 12, 1), 30);
    const query = String(q).trim();

    logger.info(
      `[UNSPLASH] Search start — query="${query}" per_page=${perPage}`,
    );

    const response = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`,
      {
        headers: {
          Authorization: `Client-ID ${unsplashAccessKey}`,
          Accept: "application/json",
        },
      },
    );

    const tApi = Date.now();
    logger.info(
      `[UNSPLASH] Unsplash API responded in ${tApi - t0} ms — status ${response.status}`,
    );

    if (!response.ok) {
      logger.error(
        `[UNSPLASH] API request failed: ${response.status} ${response.statusText}`,
      );
      return res.status(response.status).json({
        success: false,
        message: "Failed to fetch images from Unsplash",
      });
    }

    const data = await response.json();

    // Return ONLY the small URL (~400 px wide) — perfect for flashcard thumbnails
    // and good enough quality to use as the actual card image.
    // Never download, resize, or process the image server-side.
    const results = (data.results || [])
      .map((img) => ({
        id: img.id,
        small: img.urls?.small || img.urls?.thumb || null, // ~400 px wide CDN URL
        alt: img.alt_description || img.description || null,
      }))
      .filter((img) => img.small);

    const tDone = Date.now();
    logger.info(
      `[UNSPLASH] Search complete — query="${query}" results=${results.length} total=${tDone - t0} ms`,
    );

    // Allow browser to cache the response for 5 minutes
    res.set("Cache-Control", "public, max-age=300");
    return res.json({
      success: true,
      data: results,
      query,
      count: results.length,
    });
  } catch (error) {
    logger.error("[UNSPLASH] Search error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
}

module.exports = { searchUnsplashImages };
