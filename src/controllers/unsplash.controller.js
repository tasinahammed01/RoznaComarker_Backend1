const logger = require('../utils/logger');

/**
 * Search Unsplash for images
 * GET /api/unsplash/search?q=:keyword
 */
async function searchUnsplashImages(req, res) {
  try {
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({
        success: false,
        message: 'Search query parameter "q" is required'
      });
    }

    const unsplashAccessKey = process.env.UNSPLASH_ACCESS_KEY;

    if (!unsplashAccessKey) {
      logger.error('[UNSPLASH] UNSPLASH_ACCESS_KEY not configured');
      return res.status(500).json({
        success: false,
        message: 'Unsplash access key not configured'
      });
    }

    // Call Unsplash API
    const response = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=12`,
      {
        headers: {
          'Authorization': `Client-ID ${unsplashAccessKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      logger.error('[UNSPLASH] API request failed:', response.status, response.statusText);
      return res.status(response.status).json({
        success: false,
        message: 'Failed to fetch images from Unsplash'
      });
    }

    const data = await response.json();

    // Simplify the response to only necessary fields
    const simplifiedResults = (data.results || []).map(img => ({
      id: img.id,
      thumb: img.urls?.thumb || img.urls?.small || null,
      regular: img.urls?.regular || img.urls?.full || null,
      alt: img.alt_description || img.description || null
    }));

    logger.info(`[UNSPLASH] Search for "${q}" returned ${simplifiedResults.length} images`);

    res.json({
      success: true,
      data: simplifiedResults
    });
  } catch (error) {
    logger.error('[UNSPLASH] Search error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
}

module.exports = {
  searchUnsplashImages
};
