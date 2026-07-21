/**
 * projectCommands.js
 * 检测项目的 install/build/test 命令。
 *
 * 从 DeliveryEngine 抽出，供 RalphEngine 的 Validator 注入真实可执行命令使用，
 * 让验收从"看代码猜"升级为"实际运行构建与测试"。
 */

import fs from 'fs';
import path from 'path';

/** 读取并解析 package.json，失败返回 null */
function readPkg(workingDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(workingDir, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/** 检测依赖安装命令 */
export function detectInstallCmd(workingDir) {
  if (!workingDir) return 'npm install';
  if (fs.existsSync(path.join(workingDir, 'package.json'))) return 'npm install';
  if (fs.existsSync(path.join(workingDir, 'requirements.txt'))) return 'pip install -r requirements.txt';
  if (fs.existsSync(path.join(workingDir, 'pyproject.toml'))) return 'pip install -e .';
  if (fs.existsSync(path.join(workingDir, 'Cargo.toml'))) return 'cargo build';
  if (fs.existsSync(path.join(workingDir, 'go.mod'))) return 'go mod download';
  return 'echo "no install needed"';
}

/** 检测构建/类型检查命令，无则返回 null */
export function detectBuildCmd(workingDir) {
  if (!workingDir) return null;
  const pkg = readPkg(workingDir);
  if (pkg) {
    if (pkg.scripts?.build) return 'npm run build';
    if (pkg.scripts?.typecheck) return 'npm run typecheck';
    if (pkg.scripts?.compile) return 'npm run compile';
  }
  if (fs.existsSync(path.join(workingDir, 'Cargo.toml'))) return 'cargo check';
  if (fs.existsSync(path.join(workingDir, 'go.mod'))) return 'go build ./...';
  return null;
}

/** 检测测试命令，无则返回 null */
export function detectTestCmd(workingDir) {
  if (!workingDir) return null;
  const pkg = readPkg(workingDir);
  if (pkg?.scripts?.test) return 'npm test';
  if (fs.existsSync(path.join(workingDir, 'pytest.ini')) ||
      fs.existsSync(path.join(workingDir, 'pyproject.toml'))) return 'pytest';
  if (fs.existsSync(path.join(workingDir, 'Cargo.toml'))) return 'cargo test';
  if (fs.existsSync(path.join(workingDir, 'go.mod'))) return 'go test ./...';
  return null;
}

/** 一次性返回三个命令 */
export function detectProjectCommands(workingDir) {
  return {
    install: detectInstallCmd(workingDir),
    build: detectBuildCmd(workingDir),
    test: detectTestCmd(workingDir),
  };
}
