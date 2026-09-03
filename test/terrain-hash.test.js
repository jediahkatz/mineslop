import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BIOMES, createGenerator } from "../src/terrain.js";

// Captured from generated voxels before extracting terrain-profiles.js.
// These fixtures cover every v2 biome, both dimensions beyond the Overworld,
// negative and distant chunks, and the preserved v1 region.
// The 26.2 sulfur addition intentionally updates only the two v2 Overworld
// signatures: three cedar-valley chunks and two birch-river chunks gain
// underground pockets, and each signature includes the new biome's sample.
// Nether, End and legacy signatures remain unchanged.
const fixtures = [
  [
    "cedar-valley",
    "overworld",
    2,
    "ca9fcfb7f47454f511b441d2b18f74fc5e870b1b8e8d7bc751b67a79e371fe19",
  ],
  [
    "cedar-valley",
    "nether",
    2,
    "d9f587be6bbceadda1b4c96d2f2ba35e0625bf8e466ec58d7876942c385dc838",
  ],
  [
    "cedar-valley",
    "end",
    2,
    "ac4de7bb6b1ee849ba269a9df1156e49338cefd885a38376616efaf939847c27",
  ],
  [
    "birch-river",
    "overworld",
    2,
    "ab84492779446e5c40aa0aeab029ee8decd8deaec2614ce43d99e2ac2cc8b314",
  ],
  [
    "birch-river",
    "nether",
    2,
    "31b06901255b94bee83ca89544d1a7882188b0940441eeebe304010db86418e9",
  ],
  [
    "birch-river",
    "end",
    2,
    "4570d44ca88bf833d1913ac47fefd3696737933a40d2207216b2d744ace93bb6",
  ],
  [
    "cedar-valley",
    "overworld",
    1,
    "84666a2bb3e0c91e3b9458111d38641f27458358059da43de1e8173c6d1d7129",
  ],
];

// Captured from the immutable parity build before the world/items expansion.
// Preserve v3 terrain, spawn selection, every biome, both world-coordinate
// extremes and the previously inspected cave chunks when new generation lands.
const v3Fixtures = [
  [
    "cedar-valley",
    "overworld",
    3,
    "3a022b426ed486d2e07700d72e49e9e8c4d540510b205f6d9d5bb731dcd6e701",
  ],
  [
    "cedar-valley",
    "nether",
    3,
    "362d74a08b7c74153a2c8160b417e2c7042109438efa4e17766bd2f834bd7dee",
  ],
  [
    "cedar-valley",
    "end",
    3,
    "68b2927e8326de5c5e6db5c5ee38eeb797ac53c91faac78bc52c3a268f4257b7",
  ],
  [
    "birch-river",
    "overworld",
    3,
    "6337f495627a8ea1a164af8db597555249149812bd9e67dae5e3fa3b5f46a64a",
  ],
  [
    "birch-river",
    "nether",
    3,
    "228e31fe662dea9aad7228babde2a7cd1d09df2fb6476ec2f4a8c959b0f29f96",
  ],
  [
    "birch-river",
    "end",
    3,
    "e3fb70aafb6ad25438ef2aac1d0249abf91977b20ab96560e0bf5b4da0e5cc20",
  ],
];

for (const [seed, dimension, version, expected] of [
  ...fixtures,
  ...v3Fixtures,
]) {
  test(`generated terrain hash remains compatible: ${seed}/${dimension}/v${version}`, () => {
    const generator = createGenerator(seed, dimension, version);
    const coords = [
      [-5, -5],
      [4, 4],
      [-1, -1],
      [0, 0],
      [1, 1],
      [100000, -90000],
    ];
    if (version === 3) {
      coords.push([-1875000, 1874999], [1874999, -1875000], [3, 61], [8, 64]);
    }
    if (version >= 2) {
      for (const biome of BIOMES.filter(
        (entry) => entry.dimension === dimension
      )) {
        const point = generator.locateBiome(biome.id);
        assert.ok(point, biome.id);
        coords.push([Math.floor(point.x / 16), Math.floor(point.z / 16)]);
      }
    }
    const digest = createHash("sha256");
    if (version === 3) digest.update(JSON.stringify(generator.getSpawn()));
    for (const [cx, cz] of coords) {
      const chunk = generator.generateChunk(cx, cz);
      if (version === 3) {
        assert.ok(chunk.blocks instanceof Uint8Array);
        assert.equal(chunk.blocks.length, 16 * 16 * 96);
      }
      digest.update(`${cx},${cz}\n`).update(chunk.blocks).update(chunk.biomes);
    }
    assert.equal(digest.digest("hex"), expected);
  });
}

// Captured before adding sulfur: no surface height, climate, vegetation, or
// topsoil is allowed to change when introducing the underground biome.
for (const [seed, expected] of [
  [
    "cedar-valley",
    "b93a93765cb77716b3ee33ea6265786832b209fe55b44b2e0c28d293ec050858",
  ],
  [
    "birch-river",
    "0c4a8e123cef6ab735b12ea5979ada5448f6f69c2b1f7c968dc445fe564a77c2",
  ],
]) {
  test(`surface and tree hash remains unchanged after sulfur caves: ${seed}`, () => {
    const generator = createGenerator(seed, "overworld", 2);
    const digest = createHash("sha256");
    const coords = [
      [-5, -5],
      [4, 4],
      [-1, -1],
      [0, 0],
      [1, 1],
      [100000, -90000],
    ];
    for (const biome of BIOMES.filter(
      (entry) => entry.dimension === "overworld" && entry.category !== "cave"
    )) {
      const point = generator.locateBiome(biome.id);
      assert.ok(point, biome.id);
      coords.push([Math.floor(point.x / 16), Math.floor(point.z / 16)]);
    }
    for (const [cx, cz] of coords) {
      const chunk = generator.generateChunk(cx, cz);
      digest.update(`${cx},${cz}\n`).update(chunk.biomes);
      for (let z = 0; z < 16; z++)
        for (let x = 0; x < 16; x++) {
          const index = z * 16 + x;
          const top = generator.terrainHeight(cx * 16 + x, cz * 16 + z);
          digest.update(Uint8Array.of(top));
          for (let y = top - 3; y < 96; y++)
            digest.update(
              chunk.blocks.subarray(y * 256 + index, y * 256 + index + 1)
            );
        }
    }
    assert.equal(digest.digest("hex"), expected);
  });
}
