// Post-process only the lower strip of the existing resolved canvas. Keeping the
// original model draw preserves its MSAA and every pixel above the scissor band.
export class ModelFeather {
  constructor(gl) { this.gl = gl; this.allocations = 0; }
  init() {
    const gl = this.gl;
    this.vaoExtension = gl.getExtension('OES_vertex_array_object');
    const shader = (type, source) => {
      const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const error = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error(error); }
      return s;
    };
    const vertex = shader(gl.VERTEX_SHADER, 'attribute vec2 position; void main(){gl_Position=vec4(position,0.0,1.0);}');
    const fragment = shader(gl.FRAGMENT_SHADER, `
      precision highp float;
      uniform sampler2D image;
      uniform vec2 textureSize;
      uniform float band, radius;
      void main(){
        vec2 uv=gl_FragCoord.xy/textureSize;
        float keep=smoothstep(0.0,band,gl_FragCoord.y);
        vec2 d=vec2(radius*(1.0-keep))/textureSize;
        vec4 c=texture2D(image,uv)*0.28;
        c+=(texture2D(image,uv+vec2(d.x,0.0))+texture2D(image,uv-vec2(d.x,0.0))
           +texture2D(image,uv+vec2(0.0,d.y))+texture2D(image,uv-vec2(0.0,d.y)))*0.12;
        c+=(texture2D(image,uv+d)+texture2D(image,uv-d)
           +texture2D(image,uv+vec2(d.x,-d.y))+texture2D(image,uv+vec2(-d.x,d.y)))*0.06;
        // Blur premultiplied color and alpha together, then fade both together.
        gl_FragColor=c*keep;
      }`);
    this.program = gl.createProgram(); gl.attachShader(this.program, vertex); gl.attachShader(this.program, fragment); gl.bindAttribLocation(this.program, 0, 'position'); gl.linkProgram(this.program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    this.uniforms = Object.fromEntries(['image','textureSize','band','radius'].map(name => [name, gl.getUniformLocation(this.program, name)]));
    if (this.vaoExtension) { this.vao = this.vaoExtension.createVertexArrayOES(); this.vaoExtension.bindVertexArrayOES(this.vao); }
    this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    if (this.vaoExtension) this.bindPosition();
  }
  bindPosition() { const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); }
  apply(canvas) {
    const gl = this.gl, vao = gl.getExtension('OES_vertex_array_object');
    // WebGL1 without VAOs: restore exactly the one attribute this pass changes.
    const attribute = vao ? null : Object.fromEntries(['BUFFER_BINDING','ENABLED','SIZE','TYPE','NORMALIZED','STRIDE'].map(key => [key, gl.getVertexAttrib(0, gl['VERTEX_ATTRIB_ARRAY_' + key])]));
    // A null attribute pointer cannot be restored through WebGL1. Keep the model
    // visible and report a degraded effect instead of disrupting its draw loop.
    if (attribute && !attribute.BUFFER_BINDING) { this.status = 'unavailable-attribute-state'; return false; }
    if (attribute) attribute.offset = gl.getVertexAttribOffset(0, gl.VERTEX_ATTRIB_ARRAY_POINTER);
    const saved = { framebuffer:gl.getParameter(gl.FRAMEBUFFER_BINDING), viewport:gl.getParameter(gl.VIEWPORT), program:gl.getParameter(gl.CURRENT_PROGRAM), arrayBuffer:gl.getParameter(gl.ARRAY_BUFFER_BINDING), vao:vao && gl.getParameter(vao.VERTEX_ARRAY_BINDING_OES), activeTexture:gl.getParameter(gl.ACTIVE_TEXTURE), scissor:gl.getParameter(gl.SCISSOR_BOX), colorMask:gl.getParameter(gl.COLOR_WRITEMASK) };
    const capabilities = [gl.BLEND,gl.SCISSOR_TEST,gl.CULL_FACE,gl.DEPTH_TEST,gl.STENCIL_TEST,gl.DITHER].map(key => [key,gl.isEnabled(key)]);
    gl.activeTexture(gl.TEXTURE0); saved.texture0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
    try {
      if (!this.program) this.init();
      const scale = canvas.height / Math.max(1, canvas.clientHeight);
      this.bandCss = canvas.clientHeight * .14; this.radiusCss = canvas.clientHeight / 340 * 2.75;
      const band = this.bandCss * scale, radius = this.radiusCss * scale;
      const width = canvas.width, height = Math.min(canvas.height, Math.ceil(band + radius + 2));
      if (!this.texture) this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      if (this.width !== width || this.height !== height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.width = width; this.height = height; this.allocations++;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
      for (const [key] of capabilities) gl.disable(key);
      gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, width, Math.ceil(band));
      gl.colorMask(true,true,true,true); gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(this.program); if (vao) vao.bindVertexArrayOES(this.vao); else this.bindPosition();
      gl.uniform1i(this.uniforms.image, 0); gl.uniform2f(this.uniforms.textureSize, width, height); gl.uniform1f(this.uniforms.band, band); gl.uniform1f(this.uniforms.radius, radius);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.status = vao ? 'vao' : 'restored-attribute';
      return true;
    } finally {
      if (vao) vao.bindVertexArrayOES(saved.vao);
      else { gl.bindBuffer(gl.ARRAY_BUFFER, attribute.BUFFER_BINDING); gl.vertexAttribPointer(0, attribute.SIZE, attribute.TYPE, attribute.NORMALIZED, attribute.STRIDE, attribute.offset); attribute.ENABLED ? gl.enableVertexAttribArray(0) : gl.disableVertexAttribArray(0); }
      gl.bindBuffer(gl.ARRAY_BUFFER, saved.arrayBuffer);
      gl.bindTexture(gl.TEXTURE_2D, saved.texture0); gl.activeTexture(saved.activeTexture);
      gl.useProgram(saved.program); gl.bindFramebuffer(gl.FRAMEBUFFER, saved.framebuffer);
      gl.viewport(...saved.viewport); gl.scissor(...saved.scissor); gl.colorMask(...saved.colorMask);
      for (const [key, enabled] of capabilities) enabled ? gl.enable(key) : gl.disable(key);
    }
  }
  releaseTexture() { if (this.texture) this.gl.deleteTexture(this.texture); this.texture = null; this.width = this.height = 0; }
  dispose() { this.releaseTexture(); if (this.program) this.gl.deleteProgram(this.program); if (this.buffer) this.gl.deleteBuffer(this.buffer); if (this.vao) this.vaoExtension.deleteVertexArrayOES(this.vao); this.program = this.buffer = this.vao = null; }
}
