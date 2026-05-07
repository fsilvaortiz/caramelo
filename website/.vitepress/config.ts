import { defineConfig } from 'vitepress';

// Caramelo lives at fsilvaortiz/caramelo, so Pages publishes the site
// at https://fsilvaortiz.github.io/caramelo/. The trailing slash is
// load-bearing — VitePress prefixes asset URLs with `base`.
const SITE_BASE = '/caramelo/';

export default defineConfig({
  base: SITE_BASE,
  lang: 'en',
  title: 'Caramelo',
  description: 'Visual spec-driven development for VS Code. LLM-agnostic. Compatible with GitHub Spec Kit.',

  head: [
    ['link', { rel: 'icon', href: `${SITE_BASE}favicon.svg`, type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#FFC107' }],
    ['meta', { property: 'og:title', content: 'Caramelo — Visual Spec-Driven Development' }],
    ['meta', { property: 'og:description', content: 'A VS Code extension that brings GitHub Spec Kit to a visual UI. Works with any LLM provider — Claude, OpenAI, Copilot, Ollama, and more.' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:url', content: 'https://fsilvaortiz.github.io/caramelo/' }],
  ],

  // Auto-generated last-updated timestamps from git history.
  lastUpdated: true,
  cleanUrls: true,

  themeConfig: {
    logo: '/caramelo-logo.png',
    siteTitle: 'Caramelo',

    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Reference', link: '/reference/settings', activeMatch: '/reference/' },
      { text: 'Marketplace', link: 'https://marketplace.visualstudio.com/items?itemName=fsilvaortiz.caramelo' },
      { text: 'Changelog', link: '/reference/changelog' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Get started',
          items: [
            { text: 'Installation & first run', link: '/guide/getting-started' },
            { text: 'Configure providers', link: '/guide/providers' },
          ],
        },
        {
          text: 'Workflow',
          items: [
            { text: 'Spec-driven flow', link: '/guide/workflow' },
            { text: 'Constitution', link: '/guide/constitution' },
            { text: 'Agent loop & tools', link: '/guide/agent' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Settings', link: '/reference/settings' },
            { text: 'Tools', link: '/reference/tools' },
            { text: 'Changelog', link: '/reference/changelog' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/fsilvaortiz/caramelo' },
    ],

    editLink: {
      pattern: 'https://github.com/fsilvaortiz/caramelo/edit/main/website/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Fabián Silva',
    },

    search: {
      provider: 'local',
    },
  },
});
