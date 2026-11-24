// Exporta o cartão animado como MP4 (H.264 + AAC) no navegador, com WebCodecs
// e mp4-muxer (web/js/mp4-muxer.js). Usado pelo Dart via dart:js_interop.
(function () {
  'use strict';

  var AUDIO_RATE = 48000;
  var AUDIO_CHUNK = 1024;
  var VIDEO_CODECS = ['avc1.4d0028', 'avc1.42001f'];
  var AUDIO_CODEC = 'mp4a.40.2';

  function temVideo() {
    return typeof VideoEncoder !== 'undefined' &&
      typeof VideoFrame !== 'undefined' &&
      typeof Mp4Muxer !== 'undefined';
  }

  function temAudio() {
    return typeof AudioEncoder !== 'undefined' &&
      typeof AudioData !== 'undefined';
  }

  async function configVideo(width, height, fps, bitrate) {
    if (!temVideo()) return null;
    for (var i = 0; i < VIDEO_CODECS.length; i++) {
      var cfg = {
        codec: VIDEO_CODECS[i], width: width, height: height,
        bitrate: bitrate, framerate: fps, avc: { format: 'avc' },
      };
      try {
        var r = await VideoEncoder.isConfigSupported(cfg);
        if (r && r.supported) return cfg;
      } catch (e) { /* tenta o próximo */ }
    }
    return null;
  }

  async function configAudio() {
    if (!temAudio()) return null;
    var cfg = {
      codec: AUDIO_CODEC, sampleRate: AUDIO_RATE, numberOfChannels: 1,
      bitrate: 96000,
    };
    try {
      var r = await AudioEncoder.isConfigSupported(cfg);
      if (r && r.supported) return cfg;
    } catch (e) { /* sem AAC */ }
    return null;
  }

  // Devolve [temVideo, temAudio] para a largura e altura pedidas.
  async function capacidades(width, height) {
    var v = await configVideo(width, height, 20, 3000000);
    var a = await configAudio();
    return [v !== null, a !== null];
  }

  // Voz (URL de blob) -> Float32Array mono em 48 kHz, no máximo maxSamples.
  async function decodificarVoz(url, maxSamples) {
    var resp = await fetch(url);
    var bruto = await resp.arrayBuffer();
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx();
    var buf;
    try {
      buf = await new Promise(function (ok, erro) {
        // Callbacks e promessa: funciona também no Safari mais antigo.
        var p = ctx.decodeAudioData(bruto, ok, erro);
        if (p && p.then) p.then(ok, erro);
      });
    } finally {
      if (ctx.close) ctx.close();
    }
    var n = Math.min(maxSamples, Math.ceil(buf.duration * AUDIO_RATE));
    var off = new OfflineAudioContext(1, Math.max(1, n), AUDIO_RATE);
    var src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination); // mistura para mono e reamostra
    src.start(0);
    var saida = await off.startRendering();
    return saida.getChannelData(0);
  }

  function Sessao(opts) {
    this.opts = opts;
    this.n = 0;
    this.erro = null;
    this.audioOk = false;
    this.cfgAudio = null;
  }

  Sessao.prototype.checar = function () {
    if (this.erro) throw this.erro;
  };

  Sessao.prototype.iniciar = async function () {
    var o = this.opts;
    var cfgV = await configVideo(o.width, o.height, o.fps, o.bitrate);
    if (!cfgV) throw new Error('Sem codificador de vídeo H.264.');
    this.cfgAudio = await configAudio();
    this.target = new Mp4Muxer.ArrayBufferTarget();
    var muxOpts = {
      target: this.target,
      video: { codec: 'avc', width: o.width, height: o.height },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    };
    if (this.cfgAudio) {
      muxOpts.audio = {
        codec: 'aac', numberOfChannels: 1, sampleRate: AUDIO_RATE,
      };
    }
    this.muxer = new Mp4Muxer.Muxer(muxOpts);
    var self = this;
    this.venc = new VideoEncoder({
      output: function (chunk, meta) {
        try { self.muxer.addVideoChunk(chunk, meta); } catch (e) { self.erro = e; }
      },
      error: function (e) { self.erro = e; },
    });
    this.venc.configure(cfgV);
  };

  Sessao.prototype.quadro = async function (rgba) {
    this.checar();
    var o = this.opts;
    // Contrapressão: espera o codificador esvaziar a fila.
    while (this.venc.encodeQueueSize > 5) {
      await new Promise(function (r) { setTimeout(r, 4); });
      this.checar();
    }
    var us = Math.round(this.n * 1e6 / o.fps);
    var frame = new VideoFrame(rgba, {
      format: 'RGBA', codedWidth: o.width, codedHeight: o.height,
      timestamp: us, duration: Math.round(1e6 / o.fps),
    });
    try {
      this.venc.encode(frame, { keyFrame: this.n % (o.fps * 2) === 0 });
    } finally {
      frame.close();
    }
    this.n++;
  };

  Sessao.prototype.codificarAudio = async function () {
    var o = this.opts;
    var total = Math.round(this.n * AUDIO_RATE / o.fps);
    var pcm = new Float32Array(total); // silêncio por padrão
    if (o.voz) {
      var voz = await decodificarVoz(o.voz, total);
      pcm.set(voz.subarray(0, Math.min(voz.length, total)));
    }
    var self = this;
    var aenc = new AudioEncoder({
      output: function (chunk, meta) {
        try { self.muxer.addAudioChunk(chunk, meta); } catch (e) { self.erro = e; }
      },
      error: function (e) { self.erro = e; },
    });
    aenc.configure(this.cfgAudio);
    for (var i = 0; i < total; i += AUDIO_CHUNK) {
      var len = Math.min(AUDIO_CHUNK, total - i);
      var data = new AudioData({
        format: 'f32-planar', sampleRate: AUDIO_RATE,
        numberOfFrames: len, numberOfChannels: 1,
        timestamp: Math.round(i * 1e6 / AUDIO_RATE),
        data: pcm.slice(i, i + len),
      });
      aenc.encode(data);
      data.close();
      while (aenc.encodeQueueSize > 20) {
        await new Promise(function (r) { setTimeout(r, 2); });
      }
      this.checar();
    }
    await aenc.flush();
    aenc.close();
  };

  Sessao.prototype.finalizar = async function () {
    this.checar();
    await this.venc.flush();
    this.venc.close();
    this.checar();
    this.audioOk = false;
    if (this.cfgAudio) {
      await this.codificarAudio();
      this.audioOk = true;
    }
    this.checar();
    this.muxer.finalize();
    return new Uint8Array(this.target.buffer);
  };

  Sessao.prototype.abortar = function () {
    try {
      if (this.venc && this.venc.state !== 'closed') this.venc.close();
    } catch (e) { /* já fechado */ }
  };

  var atual = null;
  var player = null;

  window.cardVideoWeb = {
    capacidades: capacidades,
    iniciar: async function (width, height, fps, bitrate, voz) {
      if (atual) atual.abortar();
      atual = new Sessao({
        width: width, height: height, fps: fps, bitrate: bitrate,
        voz: voz || null,
      });
      await atual.iniciar();
      return true;
    },
    quadro: function (rgba) { return atual.quadro(rgba); },
    // Devolve o MP4; a flag cardVideoWebAudioOk diz se o áudio entrou.
    finalizar: async function () {
      var s = atual;
      var bytes = await s.finalizar();
      window.cardVideoWebAudioOk = s.audioOk;
      return bytes;
    },
    abortar: function () {
      if (atual) atual.abortar();
      atual = null;
    },
    tocar: function (url) {
      this.parar();
      player = new Audio(url);
      var p = player.play();
      if (p && p.catch) p.catch(function () {});
    },
    parar: function () {
      if (player) {
        try { player.pause(); } catch (e) { /* ignora */ }
        player = null;
      }
    },
  };
})();
