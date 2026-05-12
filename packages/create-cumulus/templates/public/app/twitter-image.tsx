// Twitter pulls the same OG card (1200×630, summary_large_image).
// Re-export the OG handler so we ship a single visual asset.
export { default, alt, size, contentType } from './opengraph-image';
