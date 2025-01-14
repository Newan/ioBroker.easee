const axios = require("axios").default;
function isObject(it) {
  return Object.prototype.toString.call(it) === '[object Object]';
}
function isArray(it) {
  if (typeof Array.isArray === 'function') {
      return Array.isArray(it);
  }
  return Object.prototype.toString.call(it) === '[object Array]';
}
async function translateText(text, targetLang, yandexApiKey) {
  if (targetLang === 'en') {
      return text;
  } else if (!text) {
      return '';
  }
  if (yandexApiKey) {
      return translateYandex(text, targetLang, yandexApiKey);
  } else {
      return translateGoogle(text, targetLang);
  }
}
async function translateYandex(text, targetLang, apiKey) {
    if (targetLang === 'zh-cn') {
        targetLang = 'zh';
    }
    try {
        const url = `https://translate.yandex.net/api/v1.5/tr.json/translate?key=${apiKey}&text=${encodeURIComponent(text)}&lang=en-${targetLang}`;
        const response = await axios({url, timeout: 15000});
        if (response.data && response.data.text && isArray(response.data.text)) {
            return response.data.text[0];
        }
        throw new Error('Invalid response for translate request');
    } catch (e) {
        throw new Error(`Could not translate to "${targetLang}": ${e}`);
    }
}
async function translateGoogle(text, targetLang) {
    try {
        const url = `http://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}&ie=UTF-8&oe=UTF-8`;
        const response = await axios({url, timeout: 15000});
        if (isArray(response.data)) {
            // we got a valid response
            return response.data[0][0][0];
        }
        throw new Error('Invalid response for translate request');
    } catch (e) {
        if (e.response && e.response.status === 429) {
            throw new Error(
                `Could not translate to "${targetLang}": Rate-limited by Google Translate`
            );
        } else {
            throw new Error(`Could not translate to "${targetLang}": ${e}`);
        }
    }
}
module.exports = {
    isArray,
    isObject,
    translateText
};
