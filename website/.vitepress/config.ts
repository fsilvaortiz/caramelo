import { defineConfig, type HeadConfig } from 'vitepress';

// GitHub Pages serves the site on a custom domain (Settings → Pages), so
// it lives at the root. The old https://fsilvaortiz.github.io/caramelo/
// URLs redirect there automatically.
const SITE_URL = 'https://caramelo.fsilvao.dev';

// Structured data for the home page, so search engines know it is a free
// VS Code extension (https://schema.org/SoftwareApplication).
const SOFTWARE_LD = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Caramelo',
  description: 'VS Code extension for spec-driven development, compatible with GitHub Spec Kit, that works with any LLM provider.',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Windows, macOS, Linux',
  url: `${SITE_URL}/`,
  downloadUrl: 'https://marketplace.visualstudio.com/items?itemName=fsilvaortiz.caramelo',
  image: `${SITE_URL}/caramelo-logo.png`,
  license: 'https://opensource.org/licenses/MIT',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  author: { '@type': 'Person', name: 'Fabián Silva', url: 'https://github.com/fsilvaortiz' },
};

export default defineConfig({
  lang: 'en',
  title: 'Caramelo',
  description: 'Visual spec-driven development for VS Code. LLM-agnostic. Compatible with GitHub Spec Kit.',

  sitemap: { hostname: `${SITE_URL}/` },

  head: [
    ['link', { rel: 'icon', href: '/favicon.png', type: 'image/png' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,600..800&family=JetBrains+Mono:wght@400;500&display=swap' }],
    ['meta', { name: 'theme-color', content: '#e8873a' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Caramelo' }],
    ['meta', { property: 'og:image', content: `${SITE_URL}/og.png` }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],

  // Per page: canonical URL, and Open Graph title/description/url taken
  // from the page so shared links and search results describe that page.
  transformHead({ pageData, title, description }) {
    const slug = pageData.relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
    const url = `${SITE_URL}/${slug}`;
    const head: HeadConfig[] = [
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
    ];
    if (slug === '') head.push(['script', { type: 'application/ld+json' }, JSON.stringify(SOFTWARE_LD)]);
    return head;
  },

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
            { text: 'Spec Kit integration', link: '/guide/spec-kit' },
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
