/**
 * next/image shim (basic)
 *
 * For now, renders a standard <img> tag with the provided props.
 * TODO: Wire up @unpic/react for proper optimization.
 */
import React, { forwardRef, type ImgHTMLAttributes } from "react";

interface ImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "width" | "height"> {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  placeholder?: "blur" | "empty";
  blurDataURL?: string;
  loader?: (params: { src: string; width: number; quality?: number }) => string;
  sizes?: string;
}

const Image = forwardRef<HTMLImageElement, ImageProps>(function Image(
  { src, alt, width, height, fill, priority, quality: _, placeholder: __, blurDataURL: ___, loader, sizes, ...rest },
  ref,
) {
  const imgSrc = loader ? loader({ src, width: width ?? 0, quality: 75 }) : src;

  const style: React.CSSProperties = fill
    ? {
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        ...((rest.style as React.CSSProperties) ?? {}),
      }
    : ((rest.style as React.CSSProperties) ?? {});

  return (
    <img
      ref={ref}
      src={imgSrc}
      alt={alt}
      width={fill ? undefined : width}
      height={fill ? undefined : height}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      sizes={sizes}
      style={style}
      {...rest}
    />
  );
});

export default Image;
