import * as fs from 'fs';
import * as path from 'path';

import { BrowserWindow, shell, ipcMain, dialog } from 'electron';
import windowStateKeeper from 'electron-window-state';

import {
  isOSX,
  linkIsInternal,
  getCssToInject,
  shouldInjectCss,
  getAppIcon,
  nativeTabsSupported,
  getCounterValue,
} from '../helpers/helpers';
import { initContextMenu } from './contextMenu';
import { onNewWindowHelper } from './mainWindowHelpers';
import { createMenu } from './menu';

const ZOOM_INTERVAL = 0.1;

function hideWindow(window, event, fastQuit, tray): void {
  if (isOSX() && !fastQuit) {
    // this is called when exiting from clicking the cross button on the window
    event.preventDefault();
    window.hide();
  } else if (!fastQuit && tray) {
    event.preventDefault();
    window.hide();
  }
  // will close the window on other platforms
}

function injectCss(browserWindow: BrowserWindow): void {
  if (!shouldInjectCss()) {
    return;
  }

  const cssToInject = getCssToInject();

  const injectCss = () => {
    browserWindow.webContents.insertCSS(cssToInject);
  };
  const onHeadersReceived = (details, callback) => {
    injectCss();
    callback({ cancel: false, responseHeaders: details.responseHeaders });
  };

  browserWindow.webContents.on('did-finish-load', () => {
    // remove the injection of css the moment the page is loaded
    browserWindow.webContents.session.webRequest.onHeadersReceived(null);
  });

  // on every page navigation inject the css
  browserWindow.webContents.on('did-navigate', () => {
    // we have to inject the css in onHeadersReceived so they're early enough
    // will run multiple times, so did-finish-load will remove this handler
    browserWindow.webContents.session.webRequest.onHeadersReceived(
      { urls: [] }, // Pass an empty filter list; null will not match _any_ urls
      onHeadersReceived,
    );
  });
}

async function clearCache(browserWindow: BrowserWindow): Promise<void> {
  const { session } = browserWindow.webContents;
  await session.clearStorageData();
  await session.clearCache();
}

function setProxyRules(browserWindow: BrowserWindow, proxyRules): void {
  browserWindow.webContents.session.setProxy({
    proxyRules,
    pacScript: '',
    proxyBypassRules: '',
  });
}

/**
 * @param {{}} nativefierOptions AppArgs from nativefier.json
 * @param {function} onAppQuit
 * @param {function} setDockBadge
 */
export function createMainWindow(
  nativefierOptions,
  onAppQuit,
  setDockBadge,
): BrowserWindow {
  const options = { ...nativefierOptions };
  const mainWindowState = windowStateKeeper({
    defaultWidth: options.width || 1280,
    defaultHeight: options.height || 800,
  });

  const DEFAULT_WINDOW_OPTIONS = {
    // Convert dashes to spaces because on linux the app name is joined with dashes
    title: options.name,
    tabbingIdentifier: nativeTabsSupported() ? options.name : undefined,
    webPreferences: {
      javascript: true,
      plugins: true,
      nodeIntegration: false, // `true` is *insecure*, and cause trouble with messenger.com
      webSecurity: !options.insecure,
      preload: path.join(__dirname, 'preload.js'),
      zoomFactor: options.zoom,
    },
  };

  const browserwindowOptions = { ...options.browserwindowOptions };

  const mainWindow = new BrowserWindow({
    frame: !options.hideWindowFrame,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    maxWidth: options.maxWidth,
    maxHeight: options.maxHeight,
    x: options.x,
    y: options.y,
    autoHideMenuBar: !options.showMenuBar,
    icon: getAppIcon(),
    // set to undefined and not false because explicitly setting to false will disable full screen
    fullscreen: options.fullScreen || undefined,
    // Whether the window should always stay on top of other windows. Default is false.
    alwaysOnTop: options.alwaysOnTop,
    titleBarStyle: options.titleBarStyle,
    show: options.tray !== 'start-in-tray',
    backgroundColor: options.backgroundColor,
    ...DEFAULT_WINDOW_OPTIONS,
    ...browserwindowOptions,
  });

  mainWindowState.manage(mainWindow);

  // after first run, no longer force maximize to be true
  if (options.maximize) {
    mainWindow.maximize();
    options.maximize = undefined;
    try {
      fs.writeFileSync(
        path.join(__dirname, '..', 'nativefier.json'),
        JSON.stringify(options),
      );
    } catch (exception) {
      // eslint-disable-next-line no-console
      console.log(`WARNING: Ignored nativefier.json rewrital (${exception})`);
    }
  }

  const withFocusedWindow = (block) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) {
      return block(focusedWindow);
    }
    return undefined;
  };

  const adjustWindowZoom = (window, adjustment) => {
    window.webContents.getZoomFactor((zoomFactor) => {
      window.webContents.setZoomFactor(zoomFactor + adjustment);
    });
  };

  const onZoomIn = () => {
    withFocusedWindow((focusedWindow) =>
      adjustWindowZoom(focusedWindow, ZOOM_INTERVAL),
    );
  };

  const onZoomOut = () => {
    withFocusedWindow((focusedWindow) =>
      adjustWindowZoom(focusedWindow, -ZOOM_INTERVAL),
    );
  };

  const onZoomReset = () => {
    withFocusedWindow((focusedWindow) => {
      focusedWindow.webContents.setZoomFactor(options.zoom);
    });
  };

  const clearAppData = async () => {
    const response = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Yes', 'Cancel'],
      defaultId: 1,
      title: 'Clear cache confirmation',
      message:
        'This will clear all data (cookies, local storage etc) from this app. Are you sure you wish to proceed?',
    });

    if (response.response !== 0) {
      return;
    }
    await clearCache(mainWindow);
  };

  const onGoBack = () => {
    withFocusedWindow((focusedWindow) => {
      focusedWindow.webContents.goBack();
    });
  };

  const onGoForward = () => {
    withFocusedWindow((focusedWindow) => {
      focusedWindow.webContents.goForward();
    });
  };

  const getCurrentUrl = () =>
    withFocusedWindow((focusedWindow) => focusedWindow.webContents.getURL());

  const onWillNavigate = (event, urlToGo) => {
    if (!linkIsInternal(options.targetUrl, urlToGo, options.internalUrls)) {
      event.preventDefault();
      shell.openExternal(urlToGo);
    }
  };

  let createNewWindow: (url: string) => BrowserWindow;

  const createNewTab = (url, foreground) => {
    withFocusedWindow((focusedWindow) => {
      const newTab = createNewWindow(url);
      focusedWindow.addTabbedWindow(newTab);
      if (!foreground) {
        focusedWindow.focus();
      }
      return newTab;
    });
    return undefined;
  };

  const createAboutBlankWindow = () => {
    const window = createNewWindow('about:blank');
    window.hide();
    window.webContents.once('did-stop-loading', () => {
      if (window.webContents.getURL() === 'about:blank') {
        window.close();
      } else {
        window.show();
      }
    });
    return window;
  };

  const onNewWindow = (event, urlToGo, _, disposition) => {
    const preventDefault = (newGuest) => {
      event.preventDefault();
      if (newGuest) {
        // eslint-disable-next-line no-param-reassign
        event.newGuest = newGuest;
      }
    };
    onNewWindowHelper(
      urlToGo,
      disposition,
      options.targetUrl,
      options.internalUrls,
      preventDefault,
      shell.openExternal,
      createAboutBlankWindow,
      nativeTabsSupported,
      createNewTab,
    );
  };

  const sendParamsOnDidFinishLoad = (window) => {
    window.webContents.on('did-finish-load', () => {
      window.webContents.send('params', JSON.stringify(options));
    });
  };

  createNewWindow = (url: string) => {
    const window = new BrowserWindow(DEFAULT_WINDOW_OPTIONS);
    if (options.userAgent) {
      window.webContents.userAgent = options.userAgent;
    }

    if (options.proxyRules) {
      setProxyRules(window, options.proxyRules);
    }

    injectCss(window);
    sendParamsOnDidFinishLoad(window);
    window.webContents.on('new-window', onNewWindow);
    window.webContents.on('will-navigate', onWillNavigate);
    window.loadURL(url);
    return window;
  };

  const menuOptions = {
    nativefierVersion: options.nativefierVersion,
    appQuit: onAppQuit,
    zoomIn: onZoomIn,
    zoomOut: onZoomOut,
    zoomReset: onZoomReset,
    zoomBuildTimeValue: options.zoom,
    goBack: onGoBack,
    goForward: onGoForward,
    getCurrentUrl,
    clearAppData,
    disableDevTools: options.disableDevTools,
  };

  createMenu(menuOptions);
  if (!options.disableContextMenu) {
    initContextMenu(
      createNewWindow,
      nativeTabsSupported() ? createNewTab : undefined,
    );
  }

  if (options.userAgent) {
    mainWindow.webContents.userAgent = options.userAgent;
  }

  if (options.proxyRules) {
    setProxyRules(mainWindow, options.proxyRules);
  }

  injectCss(mainWindow);
  sendParamsOnDidFinishLoad(mainWindow);

  if (options.counter) {
    mainWindow.on('page-title-updated', (e, title) => {
      const counterValue = getCounterValue(title);
      if (counterValue) {
        setDockBadge(counterValue, options.bounce);
      } else {
        setDockBadge('');
      }
    });
  } else {
    ipcMain.on('notification', () => {
      if (!isOSX() || mainWindow.isFocused()) {
        return;
      }
      setDockBadge('•', options.bounce);
    });
    mainWindow.on('focus', () => {
      setDockBadge('');
    });
  }

  ipcMain.on('notification-click', () => {
    mainWindow.show();
  });

  mainWindow.webContents.on('new-window', onNewWindow);
  mainWindow.webContents.on('will-navigate', onWillNavigate);

  if (options.clearCache) {
    clearCache(mainWindow);
  }

  mainWindow.loadURL(options.targetUrl);

  // @ts-ignore
  mainWindow.on('new-tab', () => createNewTab(options.targetUrl, true));

  mainWindow.on('close', (event) => {
    if (mainWindow.isFullScreen()) {
      if (nativeTabsSupported()) {
        mainWindow.moveTabToNewWindow();
      }
      mainWindow.setFullScreen(false);
      mainWindow.once(
        'leave-full-screen',
        hideWindow.bind(this, mainWindow, event, options.fastQuit),
      );
    }
    hideWindow(mainWindow, event, options.fastQuit, options.tray);

    if (options.clearCache) {
      clearCache(mainWindow);
    }
  });

  return mainWindow;
}
