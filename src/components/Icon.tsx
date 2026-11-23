const PATHS = {
  sidebar: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M7.5 3.5v13" />
    </>
  ),
  explorer: (
    <>
      <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.4l1.6 1.8H16a1.5 1.5 0 0 1 1.5 1.5v7.2A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5V5.5Z" />
    </>
  ),
  folderOpen: (
    <>
      <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.2l1.6 1.8H16a1.5 1.5 0 0 1 1.5 1.5v1.2H5.2L3 15.2a1.2 1.2 0 0 1-.5-1V5.5Z" />
      <path d="M3.2 15.5 5.2 8.5h12.3l-1.9 7H3.2Z" />
    </>
  ),
  file: (
    <>
      <path d="M5 2.5h6.5L15.5 6.5v11H5v-15Z" />
      <path d="M11.5 2.5v4h4" />
    </>
  ),
  terminal: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="m6 8 2.8 2.5L6 13m4.5 0h3.5" />
    </>
  ),
  agent: (
    <>
      <rect x="3" y="6" width="14" height="10.5" rx="3" />
      <path d="M10 6V3.2M8 3.2h4M7 10.5h.5m5 0h.5M7.5 13.5h5" />
    </>
  ),
  fit: (
    <>
      <path d="M6.5 2.5h-4v4m11-4h4v4m-15 7v4h4m11-4v4h-4" />
      <rect x="6.5" y="6.5" width="7" height="7" rx="1" />
    </>
  ),
  arrange: (
    <>
      <rect x="2.5" y="3" width="6.5" height="6" rx="1.2" />
      <rect x="11" y="3" width="6.5" height="6" rx="1.2" />
      <rect x="2.5" y="11" width="6.5" height="6" rx="1.2" />
      <rect x="11" y="11" width="6.5" height="6" rx="1.2" />
    </>
  ),
  reset: <path d="M4.2 6.2a6.8 6.8 0 1 1-1 6.8M4.2 2.5v4.2h4.2" />,
  refresh: <path d="M16.5 9.5a6.8 6.8 0 1 0-2 5.4M16.5 4.2v4.8h-4.8" />,
  close: <path d="m5.5 5.5 9 9m0-9-9 9" />,
  edit: <path d="m4 13-1 4 4-1 9.5-9.5-3-3L4 13Zm7.5-7.5 3 3" />,
  maximize: <rect x="3.5" y="3.5" width="13" height="13" rx="1.5" />,
  restore: (
    <>
      <rect x="3" y="6" width="10.5" height="10.5" rx="1.5" />
      <path d="M6.5 6V4.5A1.5 1.5 0 0 1 8 3h7.5A1.5 1.5 0 0 1 17 4.5V12a1.5 1.5 0 0 1-1.5 1.5H13.5" />
    </>
  ),
  plus: <path d="M10 4.2v11.6M4.2 10h11.6" />,
  play: <path d="m6.5 4 9.5 6-9.5 6V4Z" />,
  search: (
    <>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="m12.5 12.5 4.5 4.5" />
    </>
  ),
  tasks: <path d="m2.5 5.5 2 2 3-3.8m-5 8.8 2 2 3-3.8M10 5.5h7.5M10 12.5h7.5" />,
  note: (
    <>
      <path d="M4.5 2.5h7.5l3.5 3.5v11.5h-11v-15Z" />
      <path d="M12 2.5V6h3.5M7.5 10h5M7.5 13h5" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.8" />
      <path d="M10 2.5v2m0 11v2m7.5-7.5h-2m-11 0h-2m12.8-5.3-1.4 1.4m-7.8 7.8-1.4 1.4m0-10.6 1.4 1.4m7.8 7.8 1.4 1.4" />
    </>
  ),
  chevronRight: <path d="m7.5 5 5 5-5 5" />,
  chevronDown: <path d="m5 7.5 5 5 5-5" />,
  external: (
    <>
      <path d="M11 3.5h5.5V9M16.5 3.5 9.5 10.5" />
      <path d="M14.5 11.5v4A1.5 1.5 0 0 1 13 17H4.5A1.5 1.5 0 0 1 3 15.5V7A1.5 1.5 0 0 1 4.5 5.5h4" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="9.5" height="9.5" rx="1.5" />
      <path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v6.5A1.5 1.5 0 0 0 5 13h2" />
    </>
  ),
  eye: (
    <>
      <path d="M2.2 10s3-5 7.8-5 7.8 5 7.8 5-3 5-7.8 5-7.8-5-7.8-5Z" />
      <circle cx="10" cy="10" r="2.2" />
    </>
  ),
  code: <path d="m6.5 6-4 4 4 4m7-8 4 4-4 4m-2.5-9.5-2 11" />,
  folderPlus: (
    <>
      <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.4l1.6 1.8H16a1.5 1.5 0 0 1 1.5 1.5v7.2A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5V5.5Z" />
      <path d="M10 8.5v4.5M7.75 10.75h4.5" />
    </>
  ),
  command: (
    <path d="M6.5 6.5a2 2 0 1 1 2-2v11a2 2 0 1 1-2-2h7a2 2 0 1 1-2 2v-11a2 2 0 1 1 2 2h-7Z" />
  ),
  trash: <path d="M3.5 5.5h13M7.5 5.5V3h5v2.5M5.5 5.5l.8 11.5h7.4l.8-11.5M8.5 8.5v5.5m3-5.5v5.5" />,
  branch: (
    <>
      <circle cx="6" cy="4.8" r="2" />
      <circle cx="6" cy="15.2" r="2" />
      <circle cx="14.2" cy="7.5" r="2" />
      <path d="M6 6.8v6.4m0-2.2c0-2 2.2-3.5 6.2-3.5" />
    </>
  ),
  save: (
    <>
      <path d="M4 3.5h9.5l3 3V16a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
      <path d="M6.5 3.5v4.5h6V3.5M6.5 17v-5h7v5" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 15 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

export function RoninMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="100 104 320 320"
      fill="none"
      aria-hidden="true"
      className="ronin-mark"
    >
      <path
        fill="currentColor"
        transform="translate(113 352) scale(.286 -.286)"
        d="M520 778Q598 759 641.5 736.5Q685 714 685 684Q685 654 664.5 632.5Q644 611 631 611Q622 611 617.5 616Q613 621 597 657Q581 693 562.5 716Q544 739 515 762ZM147 747Q254 705 291.5 678.5Q329 652 329 622.5Q329 593 312.5 564Q296 535 280 535Q270 535 265 540.5Q260 546 250 569Q210 660 140 734ZM755 290H619Q650 200 700 139Q782 202 831 263Q860 243 882 220.5Q904 198 908.5 192.5Q913 187 913 183Q913 176 906.5 176Q900 176 893 178Q886 180 875.5 180Q865 180 846 170L720 115Q813 13 985-33V-55Q943-59 921.5-68.5Q900-78 873-107Q864-117 858-117Q845-117 772-51Q699 15 657 93.5Q615 172 593 290H495V-29L652 55L662 39Q498-105 457-158Q449-169 443-169Q432-169 377-84Q394-66 401-50Q408-34 408-2V551Q408 601 405 645Q454 632 503 609H748L778 657Q783 665 789.5 665Q796 665 838.5 637.5Q881 610 881 600.5Q881 591 841 564V412Q841 363 842 344L844 307Q844 299 835 293.5Q826 288 798 277Q770 266 762.5 266Q755 266 755 282ZM495 466H755V577H495ZM755 437H495V322H755ZM375 546L269 258Q238 172 238 117Q238 62 248 3Q258-56 258-79Q258-130 231-130Q193-130 169-106Q145-82 149-46Q163 60 163 93Q163 116 144 126.5Q125 137 55 153L58 176Q82 174 110 174Q138 174 160 184Q182 194 199 227L364 552ZM72 527Q156 493 201.5 463Q247 433 247 399Q247 378 231 348.5Q215 319 196 319Q188 319 182.5 326.5Q177 334 165 366Q137 436 63 509Z"
      />
    </svg>
  );
}
