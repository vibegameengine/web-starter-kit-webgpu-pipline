import { Abstract } from 'lamina/vanilla'
import { Vector3, Color } from 'three'

export default class WindLayer extends Abstract {
  static u_time = 0
  static u_sway = 0.5
  static u_length = 1

  static u_noiseScale = 10.0
  static u_noiseStrength = 10.0

  static u_colorA = new Color('#ade266')
  static u_colorB = new Color('#ade266')

  static u_isCurl = false

  static vertexShader = `   
    uniform float u_time;
    uniform float u_sway;
    uniform float u_length;
    uniform bool u_isCurl;

    varying vec3 v_pos;
    
    vec3 main() {
      float cover = .25;
      vec3 pos = position.xyz;
      vec3 base = vec3(pos.x, pos.y, 0.0);
      vec4 baseGP = instanceMatrix * vec4(base, 1.0);
      v_pos = baseGP.xyz;

      vec2 noise = u_isCurl ? 
        (lamina_noise_curl(baseGP.xyz * 0.1 + u_time * 0.5 * u_sway)).xy 
      : vec2(
          lamina_noise_perlin(baseGP.xyz * 0.1 + u_time * 0.5 * u_sway),
          lamina_noise_simplex(baseGP.xyz * 0.1 + u_time * 0.5 * u_sway)
        );
    
      noise = smoothstep(-1.0, 1.0, noise);
      float swingX = sin(u_time * 2.0 + noise.x * 2.0 * PI) * pow(pos.z, 2.0);
      float swingY = cos(u_time * 2.0 + noise.y * 2.0 * PI) * pow(pos.z, 2.0);
    

      pos.x += swingX;
      pos.y += swingY;


      return (pos * u_length);
    }
  `

  static fragmentShader = `
  varying vec3 v_pos;
  uniform float u_noiseScale;
  uniform float u_noiseStrength;

  uniform vec3 u_colorA;
  uniform vec3 u_colorB;

  vec4 main() {
    float n = lamina_noise_perlin(v_pos * u_noiseScale) * u_noiseStrength;

    vec3 c =  mix(u_colorB, u_colorA, n);
    return vec4(vec3(c), 1.);
  }
  `

  constructor(props) {
    super(WindLayer, {
      name: 'GrassLayer',
      ...props
    })
  }
}
