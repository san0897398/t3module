// Adapted from Magic UI Animated Beam (MIT). See ../../licenses/magic-ui.txt at module root.
"use client";

import { useEffect, useId, useState, type RefObject } from "react";
import { motion, useReducedMotion, useInView } from "motion/react";
import { getSmoothStepPath, Position } from "@xyflow/system";

import { cn } from "../classNames.ts";

export interface AnimatedBeamProps {
  className?: string;
  animated?: boolean;
  continuous?: boolean;
  pathOffset?: number;
  motionKey?: string;
  containerRef: RefObject<HTMLElement | null>; // Container ref
  fromRef: RefObject<HTMLElement | null>;
  toRef: RefObject<HTMLElement | null>;
  reverse?: boolean;
  pathColor?: string;
  pathWidth?: number;
  pathOpacity?: number;
  gradientStartColor?: string;
  gradientStopColor?: string;
  delay?: number;
  duration?: number;
  repeat?: number;
  repeatDelay?: number;
  startXOffset?: number;
  startYOffset?: number;
  endXOffset?: number;
  endYOffset?: number;
}

export const AnimatedBeam: React.FC<AnimatedBeamProps> = ({
  className,
  animated = false,
  continuous = false,
  pathOffset = 20,
  motionKey = "",
  containerRef,
  fromRef,
  toRef,
  reverse = false, // Include the reverse prop
  duration = 5,
  delay = 0,
  pathColor = "gray",
  pathWidth = 2,
  pathOpacity = 0.2,
  gradientStartColor = "#ffaa40",
  gradientStopColor = "#9c40ff",
  repeat = Infinity,
  repeatDelay = 0,
  startXOffset = 0,
  startYOffset = 0,
  endXOffset = 0,
  endYOffset = 0,
}) => {
  const id = useId();
  const reduce = useReducedMotion();
  const inView = useInView(containerRef);
  const [pathD, setPathD] = useState("");
  const [svgDimensions, setSvgDimensions] = useState({ width: 0, height: 0 });
  const [span, setSpan] = useState({ start: 0, end: 0 });

  // Calculate the gradient coordinates based on the reverse prop
  const gradientCoordinates = reverse
    ? {
        x1: ["0%", "0%"],
        x2: ["0%", "0%"],
        y1: [span.end, span.start - 24],
        y2: [span.end + 24, span.start],
      }
    : {
        x1: ["0%", "0%"],
        x2: ["0%", "0%"],
        y1: [span.start - 24, span.end],
        y2: [span.start, span.end + 24],
      };

  useEffect(() => {
    const updatePath = () => {
      if (containerRef.current && fromRef.current && toRef.current) {
        const containerRect = containerRef.current.getBoundingClientRect();
        const rectA = fromRef.current.getBoundingClientRect();
        const rectB = toRef.current.getBoundingClientRect();

        const svgWidth = containerRect.width;
        const svgHeight = containerRect.height;
        setSvgDimensions({ width: svgWidth, height: svgHeight });

        const startX = rectA.left - containerRect.left + rectA.width / 2 + startXOffset;
        const startY = rectA.top - containerRect.top + rectA.height / 2 + startYOffset;
        const endX = rectB.left - containerRect.left + rectB.width / 2 + endXOffset;
        const endY = rectB.top - containerRect.top + rectB.height / 2 + endYOffset;

        // XYFlow routes between outward-facing left handles. The reserved
        // gutter keeps the entire connector outside every card's content.
        const [d] = getSmoothStepPath({
          sourceX: startX,
          sourceY: startY,
          sourcePosition: Position.Left,
          targetX: endX,
          targetY: endY,
          targetPosition: Position.Left,
          borderRadius: 7,
          offset: pathOffset,
        });
        setPathD(d);
        setSpan((current) =>
          current.start === startY && current.end === endY ? current : { start: startY, end: endY },
        );
      }
    };

    // Initialize ResizeObserver
    const resizeObserver = new ResizeObserver(() => {
      updatePath();
    });

    // Observe the container element
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    if (fromRef.current) resizeObserver.observe(fromRef.current);
    if (toRef.current) resizeObserver.observe(toRef.current);

    // Call the updatePath initially to set the initial path
    updatePath();

    // Clean up the observer on component unmount
    return () => {
      resizeObserver.disconnect();
    };
  }, [
    containerRef,
    fromRef,
    toRef,
    pathOffset,
    startXOffset,
    startYOffset,
    endXOffset,
    endYOffset,
  ]);

  return (
    <svg
      aria-hidden="true"
      data-lineage-beam
      data-lineage-live={animated && continuous && !reduce && inView}
      fill="none"
      width={svgDimensions.width}
      height={svgDimensions.height}
      xmlns="http://www.w3.org/2000/svg"
      className={cn("pointer-events-none absolute top-0 left-0 transform-gpu stroke-2", className)}
      viewBox={`0 0 ${svgDimensions.width} ${svgDimensions.height}`}
    >
      <path
        d={pathD}
        stroke={pathColor}
        strokeWidth={pathWidth}
        strokeOpacity={pathOpacity}
        strokeLinecap="round"
      />
      {animated && !reduce && inView && (
        <path
          d={pathD}
          strokeWidth={pathWidth}
          stroke={`url(#${id})`}
          strokeOpacity="1"
          strokeLinecap="round"
        />
      )}
      {animated && !reduce && inView && (
        <defs>
          <motion.linearGradient
            className="transform-gpu"
            key={motionKey}
            id={id}
            gradientUnits={"userSpaceOnUse"}
            initial={{
              x1: "0%",
              x2: "0%",
              y1: "0%",
              y2: "0%",
            }}
            animate={{
              x1: gradientCoordinates.x1,
              x2: gradientCoordinates.x2,
              y1: gradientCoordinates.y1,
              y2: gradientCoordinates.y2,
            }}
            transition={{
              delay,
              duration,
              ease: "linear",
              repeat: continuous ? repeat : 0,
              repeatDelay,
            }}
          >
            <stop stopColor={gradientStartColor} stopOpacity="0"></stop>
            <stop stopColor={gradientStartColor}></stop>
            <stop offset="32.5%" stopColor={gradientStopColor}></stop>
            <stop offset="100%" stopColor={gradientStopColor} stopOpacity="0"></stop>
          </motion.linearGradient>
        </defs>
      )}
    </svg>
  );
};
