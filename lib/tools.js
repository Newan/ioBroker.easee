const axios = require("axios").default;

/**
 * Tests whether the given variable is a real object and not an Array
 *
 * @param {unknown} it The variable to test
 * @returns {it is Record<string, unknown>} True if the variable is an object, false otherwise
 */
function isObject(it) {
  return Object.prototype.toString.call(it) === "[object Object]";
}

/**
 * Tests whether the given variable is really an Array
 *
 * @param {unknown} it The variable to test
 * @returns {it is unknown[]} True if the variable is an array, false otherwise
 */
function isArray(it) {
  return Array.isArray(it);
}

/**
 * Translates text to the target language. Automatically chooses the right translation API.
 *
 * @param {string} text The text to translate
 * @param {string} targetLang The target language
 * @param {string} [yandexApiKey] The yandex API key. You can create one for free at https://translate.yandex.com/developers
 * @returns {Promise<string>} The translated text
 */
async function translateText(text, targetLang, yandexApiKey) {
  if (!text) {
    return "";
  }
  if (targetLang === "en") {
    return text;
  }

  return yandexApiKey
    ? translateYandex(text, targetLang, yandexApiKey)
    : translateGoogle(text, targetLang);
}

/**
 * Translates text with Yandex API
 *
 * @param {string} text The text to translate
 * @param {string} targetLang The target language
 * @param {string} apiKey The yandex API key. You can create one for free at https://translate.yandex.com/developers
 * @returns {Promise<string>} The translated text
 */
async function translateYandex(text, targetLang, apiKey) {
  if (targetLang === "zh-cn") {
    targetLang = "zh";
  }

  const url = `https://translate.yandex.net/api/v1.5/tr.json/translate?key=${apiKey}&text=${encodeURIComponent(text)}&lang=en-${targetLang}`;
  try {
    const response = await axios.get(url, { timeout: 15000 });
    if (response.data?.text && isArray(response.data.text)) {
      return response.data.text[0];
    }
    throw new Error("Invalid response for translate request");
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    console.error(error.message);
    return "";
  }
}

/**
 * Translates text with Google API
 *
 * @param {string} text The text to translate
 * @param {string} targetLang The target language
 * @returns {Promise<string>} The translated text
 */
async function translateGoogle(text, targetLang) {
  const url = `http://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}&ie=UTF-8&oe=UTF-8`;
  try {
    const response = await axios.get(url, { timeout: 15000 });
    if (
      Array.isArray(response.data) &&
      Array.isArray(response.data[0]) &&
      Array.isArray(response.data[0][0]) &&
      typeof response.data[0][0][0] === "string"
    ) {
      return response.data[0][0][0];
    }
    return "";
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    console.error(error.message);
    return "";
  }
}

module.exports = {
  isArray,
  isObject,
  translateText,
};
