type ChromeLike = typeof chrome;

function getApi(): ChromeLike | undefined {
  return typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : undefined;
}

function getLastError(): string | null {
  const api = getApi();
  const message = api?.runtime?.lastError?.message;
  return typeof message === "string" && message.trim() ? message : null;
}

export async function storageGet<T extends object>(key: string): Promise<T | undefined> {
  const browserApi = typeof browser !== "undefined"
    ? (browser as
        | {
            storage?: {
              local?: {
                get(keys: string): Promise<T | undefined>;
              };
            };
          }
        | undefined)
    : undefined;
  const browserResult = browserApi?.storage?.local?.get?.(key);
  if (browserResult && typeof browserResult.then === "function") {
    return browserResult;
  }

  const api = getApi();
  if (!api?.storage?.local) {
    throw new Error("storage API is unavailable");
  }
  return await new Promise<T | undefined>((resolve, reject) => {
    api.storage.local.get(key, (value: T | undefined) => {
      const error = getLastError();
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve(value);
    });
  });
}

export async function storageSet(value: Record<string, unknown>): Promise<void> {
  const browserApi = typeof browser !== "undefined"
    ? (browser as
        | {
            storage?: {
              local?: {
                set(items: Record<string, unknown>): Promise<void>;
              };
            };
          }
        | undefined)
    : undefined;
  const browserResult = browserApi?.storage?.local?.set?.(value);
  if (browserResult && typeof browserResult.then === "function") {
    await browserResult;
    return;
  }

  const api = getApi();
  if (!api?.storage?.local) {
    throw new Error("storage API is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    api.storage.local.set(value, () => {
      const error = getLastError();
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve();
    });
  });
}

export async function runtimeSendMessage<T = unknown>(message: unknown): Promise<T> {
  const browserApi = typeof browser !== "undefined"
    ? (browser as
        | {
            runtime?: {
              sendMessage(payload: unknown): Promise<T>;
            };
          }
        | undefined)
    : undefined;
  const browserResult = browserApi?.runtime?.sendMessage?.(message);
  if (browserResult && typeof browserResult.then === "function") {
    return browserResult;
  }

  const api = getApi();
  if (!api?.runtime?.sendMessage) {
    throw new Error("runtime API is unavailable");
  }
  return await new Promise<T>((resolve, reject) => {
    api.runtime.sendMessage(message, (response: T) => {
      const error = getLastError();
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve(response);
    });
  });
}

export async function tabsQuery(query: Record<string, unknown>): Promise<any[]> {
  const browserApi = typeof browser !== "undefined"
    ? (browser as
        | {
            tabs?: {
              query(params: Record<string, unknown>): Promise<any[]>;
            };
          }
        | undefined)
    : undefined;
  const browserResult = browserApi?.tabs?.query?.(query);
  if (browserResult && typeof browserResult.then === "function") {
    return browserResult;
  }

  const api = getApi();
  if (!api?.tabs?.query) {
    throw new Error("tabs API is unavailable");
  }
  return await new Promise<any[]>((resolve, reject) => {
    api.tabs.query(query, (tabs: any[]) => {
      const error = getLastError();
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve(tabs ?? []);
    });
  });
}

export async function tabsSendMessage<T = unknown>(tabId: number, message: unknown): Promise<T> {
  const browserApi = typeof browser !== "undefined"
    ? (browser as
        | {
            tabs?: {
              sendMessage(id: number, payload: unknown): Promise<T>;
            };
          }
        | undefined)
    : undefined;
  const browserResult = browserApi?.tabs?.sendMessage?.(tabId, message);
  if (browserResult && typeof browserResult.then === "function") {
    return browserResult;
  }

  const api = getApi();
  if (!api?.tabs?.sendMessage) {
    throw new Error("tabs API is unavailable");
  }
  return await new Promise<T>((resolve, reject) => {
    api.tabs.sendMessage(tabId, message, (response: T) => {
      const error = getLastError();
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve(response);
    });
  });
}

export async function tabsCreate(createProperties: Record<string, unknown>): Promise<any> {
  const browserApi = typeof browser !== "undefined"
    ? (browser as
        | {
            tabs?: {
              create(params: Record<string, unknown>): Promise<any>;
            };
          }
        | undefined)
    : undefined;
  const browserResult = browserApi?.tabs?.create?.(createProperties);
  if (browserResult && typeof browserResult.then === "function") {
    return browserResult;
  }

  const api = getApi();
  if (!api?.tabs?.create) {
    throw new Error("tabs API is unavailable");
  }
  return await new Promise<any>((resolve, reject) => {
    api.tabs.create(createProperties, (tab: any) => {
      const error = getLastError();
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve(tab);
    });
  });
}

export async function tabsRemove(tabId: number): Promise<void> {
  const browserApi = typeof browser !== "undefined"
    ? (browser as
        | {
            tabs?: {
              remove(id: number): Promise<void>;
            };
          }
        | undefined)
    : undefined;
  const browserResult = browserApi?.tabs?.remove?.(tabId);
  if (browserResult && typeof browserResult.then === "function") {
    await browserResult;
    return;
  }

  const api = getApi();
  if (!api?.tabs?.remove) {
    throw new Error("tabs API is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    api.tabs.remove(tabId, () => {
      const error = getLastError();
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve();
    });
  });
}

export async function tabsReload(tabId: number): Promise<void> {
  const browserApi = typeof browser !== "undefined"
    ? (browser as
        | {
            tabs?: {
              reload(id: number): Promise<void>;
            };
          }
        | undefined)
    : undefined;
  const browserResult = browserApi?.tabs?.reload?.(tabId);
  if (browserResult && typeof browserResult.then === "function") {
    await browserResult;
    return;
  }

  const api = getApi();
  if (!api?.tabs?.reload) {
    throw new Error("tabs reload API is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    api.tabs.reload(tabId, () => {
      const error = getLastError();
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve();
    });
  });
}
