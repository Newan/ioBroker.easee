"use strict";

const { expect } = require("chai");
const AxiosSignalRHttpClient = require("../lib/signalr-http-client.js");

describe("Axios SignalR HTTP client", () => {
  it("returns SignalR responses without rejecting non-2xx status codes", async () => {
    /** @type {any} */
    let axiosOptions;
    /** @type {any} */
    const httpClient = {
      request: async (options) => {
        axiosOptions = options;
        return {
          status: 401,
          statusText: "Unauthorized",
          data: "denied",
          headers: {},
        };
      },
    };
    const client = new AxiosSignalRHttpClient(httpClient);
    const response = await client.send({
      method: "POST",
      url: "https://streams.easee.com/hubs/chargers/negotiate",
      content: "",
      headers: { Authorization: "Bearer test" },
      timeout: 1000,
    });
    expect(response.statusCode).to.equal(401);
    expect(response.content).to.equal("denied");
    expect(axiosOptions.validateStatus(500)).to.equal(true);
    expect(axiosOptions.headers.Authorization).to.equal("Bearer test");
  });

  it("keeps negotiation cookies for the WebSocket connection", async () => {
    /** @type {any} */
    const httpClient = {
      request: async () => ({
        status: 200,
        statusText: "OK",
        data: "{}",
        headers: { "set-cookie": ["Affinity=test; Path=/; Secure; HttpOnly"] },
      }),
    };
    const client = new AxiosSignalRHttpClient(httpClient);
    await client.send({
      method: "POST",
      url: "https://streams.easee.com/hubs/chargers/negotiate",
    });
    expect(
      client.getCookieString("https://streams.easee.com/hubs/chargers"),
    ).to.equal("Affinity=test");
  });
});
