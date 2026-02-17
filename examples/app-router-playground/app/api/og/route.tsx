import type { NextRequest } from 'next/server';
import { ImageResponse } from 'next/og';
import type { ReactElement } from 'react';
import { join } from 'path';
import { readFile } from 'fs/promises';

export async function GET(req: NextRequest): Promise<Response | ImageResponse> {
  try {
    const { searchParams } = new URL(req.url);
    const isLight = req.headers.get('Sec-CH-Prefers-Color-Scheme') === 'light';

    const title = searchParams.has('title')
      ? searchParams.get('title')
      : 'App Router Playground';

    const file = await readFile(join(process.cwd(), './Inter-SemiBold.ttf'));
    const font = Uint8Array.from(file).buffer;

    return new ImageResponse(
      (
        <div
          style={{
            position: 'relative',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          {isLight ? <LightSvg /> : <DarkSvg />}
          <div
            style={{
              position: 'absolute',
              fontFamily: 'Inter',
              fontSize: '48px',
              fontWeight: '600',
              letterSpacing: '-0.04em',
              color: isLight ? 'black' : 'white',
              top: '250px',
              left: '50%',
              transform: 'translateX(-50%)',
              whiteSpace: 'pre-wrap',
              maxWidth: '750px',
              textAlign: 'center',
              wordWrap: 'break-word',
              overflowWrap: 'break-word',
            }}
          >
            {title}
          </div>
        </div>
      ),
      {
        width: 843,
        height: 441,
        fonts: [{ name: 'Inter', data: font, style: 'normal', weight: 400 }],
      },
    );
  } catch (e) {
    if (!(e instanceof Error)) throw e;

    // eslint-disable-next-line no-console
    console.log(e.message);
    return new Response(`Failed to generate the image`, { status: 500 });
  }
}

function LightSvg(): ReactElement {
  return (
    <svg
      fill="none"
      height="441"
      viewBox="0 0 843 441"
      width="843"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g clipPath="url(#clip0_5_3)">
        <rect fill="white" height="441" width="843" />
        <path
          d="M421 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M469 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M516 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M564 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M374 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M326 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M135 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M183 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M231 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M278 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M88 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M40 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M707 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M755 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M802 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M659 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M612 0V307"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M841 105L7.39098e-06 105"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M841 57L7.39098e-06 57"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M841 153L7.39098e-06 153"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M841 201L7.39098e-06 201"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M841 9L7.39098e-06 8.99998"
          stroke="#999999"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <rect fill="url(#paint0_radial_5_3)" height="441" width="841" x="2" />
        <g filter="url(#filter0_f_5_3)" opacity="0.3">
          <path
            d="M380.212 410C317.656 297.133 289.595 147.189 339.938 79.0527C390.281 10.9163 508.998 45.4216 547 153.881L452.005 204.983L380.212 410Z"
            fill="#7E7E7E"
          />
        </g>
        <rect
          fill="#EFEFEF"
          height="87"
          rx="13.05"
          transform="rotate(-180 465 197)"
          width="87"
          x="465"
          y="197"
        />
        <rect
          height="88.5"
          rx="13.8"
          stroke="url(#paint1_radial_5_3)"
          stroke-opacity="0.15"
          strokeWidth="1.5"
          transform="rotate(-180 465.75 197.75)"
          width="88.5"
          x="465.75"
          y="197.75"
        />
        <rect
          height="88.5"
          rx="13.8"
          stroke="url(#paint2_linear_5_3)"
          stroke-opacity="0.5"
          strokeWidth="1.5"
          transform="rotate(-180 465.75 197.75)"
          width="88.5"
          x="465.75"
          y="197.75"
        />
        <path
          d="M448.943 183.13L411.967 135.5H405V168.613H410.573V142.578L444.568 186.5C446.102 185.473 447.564 184.347 448.943 183.13Z"
          fill="url(#paint3_linear_5_3)"
        />
        <rect
          fill="url(#paint4_linear_5_3)"
          height="33.1273"
          width="5.52122"
          x="433.066"
          y="135.5"
        />
        <g filter="url(#filter1_f_5_3)">
          <path
            d="M376.011 119.882L378.011 188.882C378.011 171.215 379.511 132.682 379.511 123.882C379.511 115.082 386.178 111.882 389.511 111.382L460.011 107.882C438.844 106.382 393.511 107.082 385.511 107.882C377.511 108.682 375.844 116.215 376.011 119.882Z"
            fill="white"
          />
        </g>
      </g>
      <defs>
        <filter
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
          height="766"
          id="filter0_f_5_3"
          width="633"
          x="114"
          y="-156"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend
            in="SourceGraphic"
            in2="BackgroundImageFix"
            mode="normal"
            result="shape"
          />
          <feGaussianBlur
            result="effect1_foregroundBlur_5_3"
            stdDeviation="100"
          />
        </filter>
        <filter
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
          height="89.8817"
          id="filter1_f_5_3"
          width="92.011"
          x="372"
          y="103"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend
            in="SourceGraphic"
            in2="BackgroundImageFix"
            mode="normal"
            result="shape"
          />
          <feGaussianBlur
            result="effect1_foregroundBlur_5_3"
            stdDeviation="2"
          />
        </filter>
        <radialGradient
          cx="0"
          cy="0"
          gradientTransform="translate(418 -39) rotate(90) scale(336 640.762)"
          gradientUnits="userSpaceOnUse"
          id="paint0_radial_5_3"
          r="1"
        >
          <stop stopColor="white" stopOpacity="0" />
          <stop offset="1" stopColor="white" />
        </radialGradient>
        <radialGradient
          cx="0"
          cy="0"
          gradientTransform="translate(508.5 197) rotate(90) scale(111.857)"
          gradientUnits="userSpaceOnUse"
          id="paint1_radial_5_3"
          r="1"
        >
          <stop />
          <stop offset="1" />
        </radialGradient>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id="paint2_linear_5_3"
          x1="465"
          x2="484.031"
          y1="197"
          y2="232.344"
        >
          <stop />
          <stop offset="1" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id="paint3_linear_5_3"
          x1="430.306"
          x2="446.639"
          y1="164.256"
          y2="184.501"
        >
          <stop />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id="paint4_linear_5_3"
          x1="435.827"
          x2="435.735"
          y1="135.5"
          y2="159.828"
        >
          <stop />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <clipPath id="clip0_5_3">
          <rect fill="white" height="441" width="843" />
        </clipPath>
      </defs>
    </svg>
  );
}

function DarkSvg(): ReactElement {
  return (
    <svg
      fill="none"
      height="441"
      viewBox="0 0 843 441"
      width="843"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g clipPath="url(#clip0_1_4)">
        <rect fill="black" height="441" width="843" />
        <path
          d="M421.176 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M468.824 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M516.471 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M564.118 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M373.529 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M325.882 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M841 105L7.39098e-06 105"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M841 57L7.39098e-06 57"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M841 153L7.39098e-06 153"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M841 201L7.39098e-06 201"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M841 9L7.39098e-06 8.99998"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M135.294 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M182.941 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M230.588 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M278.235 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M87.6471 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M40 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M707.059 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M754.706 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M802.353 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M659.412 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <path
          d="M611.765 4.22058V306.779"
          stroke="#333333"
          strokeDasharray="3.18 3.18"
          strokeWidth="0.794118"
        />
        <rect fill="url(#paint0_radial_1_4)" height="441" width="841" />
        <g filter="url(#filter0_f_1_4)" opacity="0.3">
          <path
            d="M380.212 410C317.656 297.133 289.595 147.189 339.938 79.0527C390.281 10.9163 508.998 45.4216 547 153.881L452.005 204.983L380.212 410Z"
            fill="#0141FF"
          />
        </g>
        <rect
          fill="black"
          fillOpacity="0.5"
          height="87"
          rx="13.05"
          width="87"
          x="378"
          y="110"
        />
        <rect
          height="88.0875"
          rx="13.5937"
          stroke="url(#paint1_radial_1_4)"
          stroke-opacity="0.15"
          strokeWidth="1.0875"
          width="88.0875"
          x="377.456"
          y="109.456"
        />
        <rect
          height="88.0875"
          rx="13.5937"
          stroke="url(#paint2_linear_1_4)"
          stroke-opacity="0.5"
          strokeWidth="1.0875"
          width="88.0875"
          x="377.456"
          y="109.456"
        />
        <path
          d="M448.943 183.13L411.967 135.5H405V168.613H410.573V142.578L444.568 186.5C446.102 185.473 447.564 184.347 448.943 183.13Z"
          fill="url(#paint3_linear_1_4)"
        />
        <rect
          fill="url(#paint4_linear_1_4)"
          height="33.1273"
          width="5.52122"
          x="433.066"
          y="135.5"
        />
      </g>
      <defs>
        <filter
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
          height="766"
          id="filter0_f_1_4"
          width="633"
          x="114"
          y="-156"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend
            in="SourceGraphic"
            in2="BackgroundImageFix"
            mode="normal"
            result="shape"
          />
          <feGaussianBlur
            result="effect1_foregroundBlur_1_4"
            stdDeviation="100"
          />
        </filter>
        <radialGradient
          cx="0"
          cy="0"
          gradientTransform="translate(416 -39) rotate(90) scale(336 640.762)"
          gradientUnits="userSpaceOnUse"
          id="paint0_radial_1_4"
          r="1"
        >
          <stop stopOpacity="0" />
          <stop offset="1" />
        </radialGradient>
        <radialGradient
          cx="0"
          cy="0"
          gradientTransform="translate(421.5 110) rotate(90) scale(111.857)"
          gradientUnits="userSpaceOnUse"
          id="paint1_radial_1_4"
          r="1"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="white" />
        </radialGradient>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id="paint2_linear_1_4"
          x1="378"
          x2="397.031"
          y1="110"
          y2="145.344"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id="paint3_linear_1_4"
          x1="430.306"
          x2="446.639"
          y1="164.256"
          y2="184.501"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id="paint4_linear_1_4"
          x1="435.827"
          x2="435.735"
          y1="135.5"
          y2="159.828"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <clipPath id="clip0_1_4">
          <rect fill="white" height="441" width="843" />
        </clipPath>
      </defs>
    </svg>
  );
}
