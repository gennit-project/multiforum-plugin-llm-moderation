import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const validateReleaseVersion = ({ manifest, packageJson, expected }) => {
  const version = manifest?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("plugin.json must declare a valid semantic version");
  }
  if (packageJson?.version !== version) {
    throw new Error(`package.json version ${packageJson?.version ?? "<missing>"} does not match plugin.json ${version}`);
  }
  if (expected !== undefined && expected !== version) {
    throw new Error(`confirmed version ${expected} does not match declared version ${version}`);
  }
  const tag = `v${version}`;
  if (manifest?.source?.releaseNotesUrl && !manifest.source.releaseNotesUrl.endsWith(`/tag/${tag}`)) {
    throw new Error(`plugin.json source.releaseNotesUrl must end with /tag/${tag}`);
  }
  return { version, tag };
};

const main = () => {
  const expectedIndex = process.argv.indexOf("--expected");
  const expected = expectedIndex >= 0 ? process.argv[expectedIndex + 1] : undefined;
  const result = validateReleaseVersion({
    manifest: JSON.parse(fs.readFileSync("plugin.json", "utf8")),
    packageJson: JSON.parse(fs.readFileSync("package.json", "utf8")),
    expected,
  });
  process.stdout.write(`version=${result.version}\ntag=${result.tag}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
