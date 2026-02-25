import type { VCSPlatform } from './types.js';
import { exec } from '../lib/exec.js';

/**
 * Detect VCS platform from git remote URL
 *
 * Detection rules:
 * - gitlab.com or gitlab. in URL → 'gitlab'
 * - Default → 'github'
 *
 * @param projectPath - Path to git repository
 * @returns Detected platform
 */
export async function detectPlatform(projectPath: string): Promise<VCSPlatform> {
  try {
    const result = await exec('git', ['remote', 'get-url', 'origin'], { cwd: projectPath });
    const remoteUrl = result.stdout.trim();

    // GitLab detection
    if (remoteUrl.includes('gitlab.com') || remoteUrl.includes('gitlab.')) {
      return 'gitlab';
    }

    // Default to GitHub
    return 'github';
  } catch (error) {
    // If git remote fails, default to GitHub
    return 'github';
  }
}
