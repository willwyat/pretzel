export interface LightGroup {
  id: string;
  name: string;
}

export interface LightLocation {
  id: string;
  name: string;
}

export interface LightColor {
  hue: number;
  saturation: number;
  kelvin: number;
}

export interface Light {
  id: string;
  uuid?: string;
  label: string;
  connected: boolean;
  power: string;
  color?: LightColor;
  brightness?: number;
  group?: LightGroup;
  location?: LightLocation;
  product?: {
    name: string;
    identifier: string;
    company: string;
    capabilities: {
      has_color: boolean;
      has_variable_color_temp: boolean;
      min_kelvin: number;
      max_kelvin: number;
    };
  };
  last_seen?: string;
  seconds_since_seen?: number;
}
