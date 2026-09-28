import * as fs from "node:fs/promises";
import path from "node:path";

const POLICY_FILE_NAME = "review-policy.json";

class ReviewPolicyError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ReviewPolicyError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPlainObject(value, fieldPath) {
  if (!isPlainObject(value)) {
    throw new ReviewPolicyError("REVIEW_POLICY_FIELD", `${fieldPath} 必须是对象`);
  }
}

function assertAllowedKeys(value, allowedKeys, fieldPath) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new ReviewPolicyError("REVIEW_POLICY_FIELD", `${fieldPath} 不支持字段 ${key}`);
    }
  }
}

function assertDirectoryList(value, fieldPath) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new ReviewPolicyError("REVIEW_POLICY_FIELD", `${fieldPath} 必须是字符串数组`);
  }
  if (new Set(value).size !== value.length) {
    throw new ReviewPolicyError("REVIEW_POLICY_FIELD", `${fieldPath} 的值必须唯一`);
  }
}

export function validateReviewPolicyDocument(value) {
  assertPlainObject(value, "review policy");
  assertAllowedKeys(
    value,
    new Set(["$schema", "version", "changedLinesThreshold", "blacklist", "whitelist"]),
    "review policy",
  );

  if (value.version !== 1) {
    throw new ReviewPolicyError("REVIEW_POLICY_VERSION", "review policy.version 必须为 1");
  }
  if (value.$schema !== undefined && typeof value.$schema !== "string") {
    throw new ReviewPolicyError("REVIEW_POLICY_FIELD", "review policy.$schema 必须是字符串");
  }
  if (!Number.isInteger(value.changedLinesThreshold) || value.changedLinesThreshold < 1) {
    throw new ReviewPolicyError(
      "REVIEW_POLICY_FIELD",
      "review policy.changedLinesThreshold 必须是不小于 1 的整数",
    );
  }

  const hasBlacklist = Object.hasOwn(value, "blacklist");
  const hasWhitelist = Object.hasOwn(value, "whitelist");
  if (hasBlacklist === hasWhitelist) {
    throw new ReviewPolicyError(
      "REVIEW_POLICY_DIRECTORY_MODE",
      "review policy 必须且只能配置 blacklist 或 whitelist",
    );
  }
  if (hasBlacklist) assertDirectoryList(value.blacklist, "review policy.blacklist");
  if (hasWhitelist) assertDirectoryList(value.whitelist, "review policy.whitelist");
  return value;
}

export class ReviewPolicyLoader {
  constructor({ readFile = fs.readFile } = {}) {
    this.readFile = readFile;
  }

  async policyForRepository(repositoryPath) {
    if (typeof repositoryPath !== "string" || !path.isAbsolute(repositoryPath)) {
      throw new ReviewPolicyError("REVIEW_POLICY_PATH", "代码仓库路径必须是绝对路径");
    }

    const policyPath = path.join(repositoryPath, POLICY_FILE_NAME);
    let source;
    try {
      source = await this.readFile(policyPath, "utf8");
    } catch (cause) {
      if (cause.code === "ENOENT") return null;
      throw new ReviewPolicyError(
        "REVIEW_POLICY_LOAD",
        `无法读取代码仓库中的 ${POLICY_FILE_NAME}: ${cause.message}`,
        cause,
      );
    }

    try {
      const document = JSON.parse(source);
      return validateReviewPolicyDocument(document);
    } catch (cause) {
      if (cause instanceof ReviewPolicyError) throw cause;
      throw new ReviewPolicyError(
        "REVIEW_POLICY_PARSE",
        `无法解析代码仓库中的 ${POLICY_FILE_NAME}: ${cause.message}`,
        cause,
      );
    }
  }
}
