import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'wxt'

const extensionVersion = (() => {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const gitHash = (() => {
  try {
    return execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
})()

export default defineConfig({
  srcDir: 'src',
  // Support multi-browser builds via BROWSER env var
  // Both Chrome and Firefox use MV3 (Firefox 109+)
  browser: process.env.BROWSER === 'firefox' ? 'firefox' : 'chrome',
  manifestVersion: 3,
  vite: () => ({
    define: {
      __SUMMARIZE_VERSION__: JSON.stringify(extensionVersion),
      __SUMMARIZE_GIT_HASH__: JSON.stringify(gitHash),
    },
    resolve: {
      alias: {
        react: 'preact/compat',
        'react-dom': 'preact/compat',
        'react/jsx-runtime': 'preact/jsx-runtime',
        'react/jsx-dev-runtime': 'preact/jsx-dev-runtime',
      },
    },
  }),
  manifest: ({ browser }) => {
    const baseManifest = {
      name: 'Summarize',
      description: 'Summarize what you see. Articles, threads, YouTube, podcasts — anything.',
      homepage_url: 'https://summarize.sh',
      version: extensionVersion,
      icons: {
        16: 'assets/icon-16.png',
        32: 'assets/icon-32.png',
        48: 'assets/icon-48.png',
        128: 'assets/icon-128.png',
      },
      permissions: [
        'tabs',
        'activeTab',
        'storage',
        ...(browser === 'firefox' ? [] : ['sidePanel' as const]),
        'webNavigation',
        'scripting',
        'windows',
        ...(browser === 'firefox' ? [] : ['debugger' as const]),
      ],
      optional_permissions: ['userScripts'],
      host_permissions: ['<all_urls>', 'http://127.0.0.1:8787/*'],
      background: {
        type: 'module',
        service_worker: 'background.js',
      },
      action: {
        default_title: 'Summarize',
        default_icon: {
          16: 'assets/icon-16.png',
          32: 'assets/icon-32.png',
          48: 'assets/icon-48.png',
          128: 'assets/icon-128.png',
        },
      },
      ...(browser === 'firefox'
        ? {
            // Firefox uses sidebar_action API (Firefox 131+)
            sidebar_action: {
              default_panel: 'sidepanel/index.html',
              default_title: 'Summarize',
              default_icon: {
                16: 'assets/icon-16.png',
                32: 'assets/icon-32.png',
                48: 'assets/icon-48.png',
                128: 'assets/icon-128.png',
              },
            },
          }
        : {
            // Chrome uses side_panel API
            side_panel: {
              default_path: 'sidepanel/index.html',
            },
          }),
      options_ui: {
        page: 'options/index.html',
        open_in_tab: true,
      },
      // Firefox-specific settings: explicit extension ID for testing
      ...(browser === 'firefox'
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'summarize-test@steipete.com',
                strict_min_version: '131.0',
                data_collection_permissions: {
                  required: ['none'],
                },
              },
            },
          }
        : {}),
      // Keyboard shortcuts - Firefox supports opening sidebar via shortcuts
      ...(browser === 'firefox'
        ? {
            commands: {
              _execute_sidebar_action: {
                suggested_key: {
                  default: 'Ctrl+Shift+U',
                  mac: 'Command+Shift+U',
                },
                description: 'Toggle Summarize sidebar',
              },
            },
          }
        : {}),
    }
    return baseManifest
  },
})
