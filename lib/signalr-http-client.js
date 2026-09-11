"use strict";

const axios = require("axios").default;
const signalR = require("@microsoft/signalr");
const { CookieJar } = require("tough-cookie");

function hasHeader(headers, name) {
  return Object.keys(headers).some(
    (headerName) => headerName.toLowerCase() === name.toLowerCase(),
  );
}

class AxiosSignalRHttpClient extends signalR.HttpClient {
  constructor(httpClient = axios) {
    super();
    this.httpClient = httpClient;
    this.cookieJar = new CookieJar();
  }

  async send(request) {
    if (!request.url) {
      throw new Error("SignalR HTTP request URL is missing");
    }
    const headers = { ...request.headers };
    const cookie = this.cookieJar.getCookieStringSync(request.url);
    if (cookie && !hasHeader(headers, "cookie")) {
      headers.Cookie = cookie;
    }
    const cancelSource = axios.CancelToken.source();
    const abortHandler = () =>
      cancelSource.cancel("SignalR HTTP request aborted");
    if (request.abortSignal) {
      request.abortSignal.onabort = abortHandler;
    }
    try {
      const response = await this.httpClient.request({
        method: request.method || "GET",
        url: request.url,
        headers,
        data: request.content,
        timeout: request.timeout,
        cancelToken: cancelSource.token,
        responseType:
          request.responseType === "arraybuffer" ? "arraybuffer" : "text",
        transformResponse: [(data) => data],
        validateStatus: () => true,
      });
      for (const setCookie of response.headers?.["set-cookie"] || []) {
        await this.cookieJar.setCookie(setCookie, request.url, {
          ignoreError: true,
        });
      }
      let content = response.data;
      if (Buffer.isBuffer(content) && request.responseType === "arraybuffer") {
        content = content.buffer.slice(
          content.byteOffset,
          content.byteOffset + content.byteLength,
        );
      } else if (
        typeof content !== "string" &&
        request.responseType !== "arraybuffer"
      ) {
        content = content == null ? "" : JSON.stringify(content);
      }
      return new signalR.HttpResponse(
        response.status,
        response.statusText,
        content,
      );
    } finally {
      if (request.abortSignal?.onabort === abortHandler) {
        request.abortSignal.onabort = null;
      }
    }
  }

  getCookieString(url) {
    return this.cookieJar.getCookieStringSync(url);
  }
}

module.exports = AxiosSignalRHttpClient;
