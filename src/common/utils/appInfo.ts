import fs from "fs";
import path from "path";

interface PackageJson {
  name: string;
  version: string;
  description?: string;
}

const packageJsonPath = path.resolve(__dirname, "../../../package.json");
const packageJson: PackageJson = JSON.parse(
  fs.readFileSync(packageJsonPath, "utf-8")
);

export const appInfo = {
  name: packageJson.name,
  version: packageJson.version,
  startedAt: new Date().toISOString(),
};
