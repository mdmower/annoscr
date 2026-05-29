import Gdk from 'gi://Gdk?version=4.0';

import {ColorRGBA} from './actions.js';

export function colorToRgba(c: ColorRGBA): Gdk.RGBA {
  const rgba = new Gdk.RGBA();
  rgba.red = c[0];
  rgba.green = c[1];
  rgba.blue = c[2];
  rgba.alpha = c[3];
  return rgba;
}

export function rgbaToColor(rgba: Gdk.RGBA): ColorRGBA {
  return [rgba.red, rgba.green, rgba.blue, rgba.alpha];
}
