// lib/utils.js — Shared utility functions (dipakai oleh ai.js dan agent.js)
    // Dipindahkan ke sini agar tidak ada duplikasi kode antar modul.
    'use strict';

    /**
    * Buang blok <think>...</think> (dan varian <thinking>, <reasoning>)
    * yang dikirim beberapa model reasoning (mis. DeepSeek-R1 via Groq/Conduit).
    * Discord/user tidak perlu melihat proses berpikir internal model.
    */
    function stripThinkTags(text) {
    if (typeof text !== 'string' || !text) return text;
    return text
      .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
      // Kadang tag penutup hilang (respons terpotong) — buang dari tag buka sampai akhir.
      .replace(/<(think|thinking|reasoning)>[\s\S]*$/gi, '')
      .trim();
    }

    /**
    * Parse comma-separated string -> array of trimmed non-empty strings.
    * @param {string|undefined} str  - Comma-separated input (biasanya dari process.env)
    * @param {string[]}         [def=[]] - Default array jika result kosong
    */
    function parseList(str, def = []) {
    const arr = (str || '').split(',').map(s => s.trim()).filter(Boolean);
    return arr.length ? arr : (def || []);
    }

    module.exports = { stripThinkTags, parseList };
    