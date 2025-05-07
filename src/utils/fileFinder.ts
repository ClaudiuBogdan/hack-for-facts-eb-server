import * as fs from "fs-extra";
import * as path from "path";

export async function findXmlFiles(baseDataDir: string): Promise<string[]> {
  const xmlFiles: string[] = [];
  const yearDirs = await fs.readdir(baseDataDir);
  const years = yearDirs.filter((dir) => /^\d{4}$/.test(dir));

  for (const year of years) {
    const yearPath = path.join(baseDataDir, year);
    if (!(await fs.stat(yearPath)).isDirectory()) continue;

    const monthDirs = await fs.readdir(yearPath);
    for (const month of monthDirs) {
      if (!/^\d{1,2}$/.test(month)) continue;

      const monthPath = path.join(yearPath, month);
      if (!(await fs.stat(monthPath)).isDirectory()) continue;

      const monthItems = await fs.readdir(monthPath);
      for (const item of monthItems) {
        const itemPath = path.join(monthPath, item);
        if (!(await fs.stat(itemPath)).isDirectory()) continue;

        const xmlFolderPath = path.join(itemPath, "xml");
        if (await fs.pathExists(xmlFolderPath)) {
          const files = await fs.readdir(xmlFolderPath);
          for (const file of files) {
            if (file.endsWith(".xml")) {
              xmlFiles.push(path.join(xmlFolderPath, file));
            }
          }
        }
      }
    }
  }
  return xmlFiles;
}

// Helper to extract year/month from path if needed elsewhere
export function getPathContext(
  filePath: string,
  baseDataDir: string
): { year: string; month: string } {
  const relativePath = path.relative(baseDataDir, filePath);
  const parts = relativePath.split(path.sep);
  // Expected structure: year/month/item/xml/file.xml
  if (parts.length >= 4) {
    return { year: parts[0], month: parts[1] };
  }
  return { year: "unknown", month: "unknown" }; // Fallback
}
