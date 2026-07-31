import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vendorDir = join(root, "public", "vendor");
const leafletDir = join(vendorDir, "leaflet");
const fontDir = join(vendorDir, "fonts");
const licenseDir = join(vendorDir, "licenses");

await rm(vendorDir, { recursive: true, force: true });
await Promise.all([
  mkdir(join(leafletDir, "images"), { recursive: true }),
  mkdir(fontDir, { recursive: true }),
  mkdir(licenseDir, { recursive: true }),
]);

const files = [
  ["node_modules/leaflet/dist/leaflet.js", "leaflet/leaflet.js"],
  ["node_modules/leaflet/dist/leaflet.css", "leaflet/leaflet.css"],
  ["node_modules/leaflet/dist/images/layers.png", "leaflet/images/layers.png"],
  [
    "node_modules/leaflet/dist/images/layers-2x.png",
    "leaflet/images/layers-2x.png",
  ],
  [
    "node_modules/leaflet/dist/images/marker-icon.png",
    "leaflet/images/marker-icon.png",
  ],
  [
    "node_modules/leaflet/dist/images/marker-icon-2x.png",
    "leaflet/images/marker-icon-2x.png",
  ],
  [
    "node_modules/leaflet/dist/images/marker-shadow.png",
    "leaflet/images/marker-shadow.png",
  ],
  [
    "node_modules/@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff2",
    "fonts/dm-sans-latin-400-normal.woff2",
  ],
  [
    "node_modules/@fontsource/dm-sans/files/dm-sans-latin-600-normal.woff2",
    "fonts/dm-sans-latin-600-normal.woff2",
  ],
  [
    "node_modules/@fontsource/italiana/files/italiana-latin-400-normal.woff2",
    "fonts/italiana-latin-400-normal.woff2",
  ],
  ["node_modules/leaflet/LICENSE", "licenses/leaflet.txt"],
  ["node_modules/@fontsource/dm-sans/LICENSE", "licenses/dm-sans.txt"],
  ["node_modules/@fontsource/italiana/LICENSE", "licenses/italiana.txt"],
];

await Promise.all(
  files.map(async ([source, destination]) => {
    const target = join(vendorDir, destination);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, source), target);
  }),
);

const fontCss = `@font-face {
  font-family: "DM Sans";
  font-style: normal;
  font-display: swap;
  font-weight: 400;
  src: url("/vendor/fonts/dm-sans-latin-400-normal.woff2") format("woff2");
}

@font-face {
  font-family: "DM Sans";
  font-style: normal;
  font-display: swap;
  font-weight: 600;
  src: url("/vendor/fonts/dm-sans-latin-600-normal.woff2") format("woff2");
}

@font-face {
  font-family: "Italiana";
  font-style: normal;
  font-display: swap;
  font-weight: 400;
  src: url("/vendor/fonts/italiana-latin-400-normal.woff2") format("woff2");
}
`;

await writeFile(join(fontDir, "fonts.css"), fontCss);
