/**
 * Tests for Graph ID Resolution
 */

import { describe, it, expect } from 'vitest';
import { slugify, slugifyRemoteUrl, resolveGraphId } from '../graph-id.js';

describe('Graph ID Resolution', () => {
  describe('slugify', () => {
    it('should lowercase and replace non-alphanumeric chars', () => {
      expect(slugify('My Repo')).toBe('my-repo');
    });

    it('should collapse multiple hyphens', () => {
      expect(slugify('my---repo')).toBe('my-repo');
    });

    it('should trim leading/trailing hyphens', () => {
      expect(slugify('--my-repo--')).toBe('my-repo');
    });

    it('should handle special characters', () => {
      expect(slugify('my_repo.name@v2')).toBe('my-repo-name-v2');
    });

    it('should truncate to 64 characters', () => {
      const long = 'a'.repeat(100);
      expect(slugify(long).length).toBe(64);
    });

    it('should handle empty string', () => {
      expect(slugify('')).toBe('');
    });
  });

  describe('slugifyRemoteUrl', () => {
    it('should handle HTTPS URLs', () => {
      expect(slugifyRemoteUrl('https://github.com/my-org/my-repo')).toBe('my-org-my-repo');
    });

    it('should handle SSH URLs', () => {
      expect(slugifyRemoteUrl('git@github.com:my-org/my-repo.git')).toBe('my-org-my-repo');
    });

    it('should strip .git suffix', () => {
      expect(slugifyRemoteUrl('https://github.com/my-org/my-repo.git')).toBe('my-org-my-repo');
    });

    it('should handle deeply nested paths', () => {
      expect(slugifyRemoteUrl('https://github.com/org/sub/repo')).toBe('org-sub-repo');
    });
  });

  describe('resolveGraphId', () => {
    it('should prefer explicit graphId', () => {
      expect(
        resolveGraphId({
          explicitGraphId: 'my-custom-id',
          locationName: 'Some Location',
          opentasksPath: '/some/path/.opentasks',
        }),
      ).toBe('my-custom-id');
    });

    it('should use location name as second choice', () => {
      expect(
        resolveGraphId({
          locationName: 'My Project',
          opentasksPath: '/nonexistent/path/.opentasks',
        }),
      ).toBe('my-project');
    });

    it('should fall back to directory name', () => {
      expect(
        resolveGraphId({
          opentasksPath: '/some/my-project/.opentasks',
        }),
      ).toBe('my-project');
    });
  });
});
