export function prohibitedSubmissionPaths(files) {
  if (!Array.isArray(files)) return [];
  return [...new Set(
    files
      .flatMap((file) => {
        const visiblePaths = [file?.path, file?.previousPath].filter((value) => typeof value === "string");
        return visiblePaths.length > 0
          ? visiblePaths
          : (Array.isArray(file?.rawPaths) ? file.rawPaths : []);
      })
      .filter(isStaticBuildPath),
  )].sort();
}

export function isStaticBuildPath(value) {
  if (typeof value !== "string") return false;
  return value.replaceAll("\\", "/").split("/").includes("static");
}

export function staticSubmissionError(paths) {
  return `构建生成的 static 文件不允许提交或 push：${paths.join(", ")}。build 仅可用于验证，请删除这些构建产物后再继续。`;
}
