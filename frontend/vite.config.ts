import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Injects a content security policy into the built HTML.
 *
 * Build only. The dev server injects inline scripts for hot reload, which a
 * strict `script-src` would block, and a policy that has to be relaxed for
 * development is not the policy worth shipping.
 *
 * A meta tag cannot express `frame-ancestors`, and it cannot carry HSTS. Those
 * must be sent as real headers by whatever serves this bundle; SECURITY.md lists
 * the set.
 */
const contentSecurityPolicy = (): Plugin => ({
  name: 'inject-csp',
  apply: 'build',
  transformIndexHtml(html) {
    const directives = [
      "default-src 'none'",
      "script-src 'self'",
      // Vite emits a stylesheet, and inline styles are still used for a few
      // computed widths. No inline script is permitted.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      // The API origin is build-time configuration. The hosting layer should
      // narrow this to the exact origin in the header it sends.
      "connect-src 'self' https:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      'upgrade-insecure-requests',
    ].join('; ');

    return {
      html,
      tags: [
        { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: directives }, injectTo: 'head-prepend' },
        { tag: 'meta', attrs: { name: 'referrer', content: 'no-referrer' }, injectTo: 'head-prepend' },
      ],
    };
  },
});

export default defineConfig({ plugins: [react(), contentSecurityPolicy()] });
