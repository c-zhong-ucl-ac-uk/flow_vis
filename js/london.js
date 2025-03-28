// 声明全局变量
let path;
let names;
let selectedCounty = null;
let isLocked = false;
let osmMap = null; // 新增：用于存储OSM地图实例

// 在文件开头添加EPSG:27700的定义
const proj27700 = "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs";

// 初始化投影转换
proj4.defs("EPSG:27700", proj27700);

// 创建转换函数
function convertToWGS84(x, y) {
    // 从EPSG:27700转换到WGS84
    const [lon, lat] = proj4("EPSG:27700", "EPSG:4326", [x, y]);
    return [lat, lon]; // 返回[lat, lon]格式，适用于Leaflet
}

// 添加 ramp 函数
function ramp(color, n = 256) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = n;
    canvas.height = 1;

    const x = d3
        .scaleLinear()
        .domain(d3.quantize(d3.interpolate(0, n - 1), color.domain().length))
        .range(color.domain());

    for (let i = 0; i < n; ++i) {
        context.fillStyle = color(x(i));
        context.fillRect(i, 0, 1, 1);
    }
    return canvas;
}

// 添加 remap 函数，用于重新映射颜色值
function remap(value, oldMin, oldMax, newMin, newMax) {
    // 处理边界情况
    if (oldMin === oldMax) return newMin;
    if (value <= oldMin) return newMin;
    if (value >= oldMax) return newMax;

    // 线性映射
    return ((value - oldMin) / (oldMax - oldMin)) * (newMax - newMin) + newMin;
}

// 添加对数变换函数
function logTransform(value, minValue, maxValue) {
    // 确保所有值都是正数，通过将最小值平移到1
    const shift = minValue < 1 ? 1 - minValue : 0;
    const logMin = Math.log(minValue + shift);
    const logMax = Math.log(maxValue + shift);

    // 对输入值进行对数变换
    const logValue = Math.log(value + shift);

    // 将对数值映射到 [0,1] 范围
    return (logValue - logMin) / (logMax - logMin);
}

// 添加图例函数
function legend(color, title = "Flow volume", tickFormat = null) {
    const width = 240;
    const height = 40;
    const marginTop = 16;
    const marginRight = 0;
    const marginBottom = 14;
    const marginLeft = 0;
    const ticks = width / 64;

    const svg = d3
        .select("#legend")
        .append("svg")
        .attr("width", width)
        .attr("height", height)
        .attr("viewBox", [0, 0, width, height])
        .style("overflow", "visible")
        .style("display", "block");

    let tickAdjust = (g) =>
        g.selectAll(".tick line").attr("y1", marginTop + marginBottom - height);

    const x = d3
        .scaleLinear()
        .domain(color.domain())
        .range([marginLeft, width - marginRight]);

    // 创建渐变色带
    const n = 256;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = n;
    canvas.height = 1;

    // 修改颜色渐变生成方式，使用对数映射
    for (let i = 0; i < n; ++i) {
        const t = i / (n - 1);
        // 使用对数映射获取当前值
        const value = Math.exp(
            d3
            .scaleLinear()
            .domain([0, 1])
            .range([Math.log(color.domain()[0]), Math.log(color.domain()[1])])(t)
        );

        // 应用对数变换和颜色映射
        const logMapped = logTransform(value, color.domain()[0], color.domain()[1]);
        const colorValue = remap(logMapped, 0, 1, 0.2, 0.9);
        context.fillStyle = d3.interpolateBuPu(colorValue);
        context.fillRect(i, 0, 1, 1);
    }

    svg
        .append("image")
        .attr("x", marginLeft)
        .attr("y", marginTop)
        .attr("width", width - marginLeft - marginRight)
        .attr("height", height - marginTop - marginBottom)
        .attr("preserveAspectRatio", "none")
        .attr("xlink:href", canvas.toDataURL());

    svg
        .append("g")
        .attr("transform", `translate(0,${height - marginBottom})`)
        .call(
            d3
            .axisBottom(x)
            .ticks(ticks)
            .tickFormat(tickFormat || ((d) => d.toFixed(1)))
        )
        .call(tickAdjust)
        .call((g) => g.select(".domain").remove())
        .call((g) =>
            g
            .append("text")
            .attr("x", marginLeft)
            .attr("y", marginTop + marginBottom - height - 6)
            .attr("fill", "currentColor")
            .attr("text-anchor", "start")
            .attr("font-weight", "bold")
            .text(title)
        );
}

async function getNames() {
    const {
        locations: { flat },
    } = await d3.json(
        "https://gist.githubusercontent.com/mbostock/df1b792d76fcb748056ff94b912e4bb8/raw/b1da4894cfb1e56a24129c27b39aa957d7f0c165/names.json"
    );
    const map = new Map(
        Array.from(flat, ({ location_id, name }) => [location_id, name])
    );
    for (const { location_id, parent_id, level, name }
        of flat) {
        if (level === 2) {
            map.set(location_id, `${name}, ${map.get(parent_id)}`);
        }
    }
    return map;
}

// 添加更新信息框的函数
function updateLocationInfo(data = null) {
    if (!data) {
        d3.select("#location-info .info-content")
            .html(`<div class="info-id">&nbsp;</div>
<div class="info-name">Hover over a region</div>
<div class="info-data">to see flow details</div>`);
        return;
    }

    const {
        locationId,
        name,
        totalInflow,
        totalOutflow,
        connectionData,
        flowConnections,
    } = data;

    // 计算连接数量
    const totalConnections = flowConnections ? flowConnections.size : 0;
    const totalFlow = totalInflow + totalOutflow;

    // 格式化数字
    const formatNumber = (num) => {
        if (num >= 1000) {
            return `${(num / 1000).toFixed(1)}k`;
        }
        return num.toFixed(0);
    };

    d3.select("#location-info .info-content").html(`
            <div class="info-id">ID: ${locationId}</div>
            <div class="info-name">${name}</div>
            <div class="info-data">
                <div class="flow-summary">
                    <div class="total-flow">
                        <span class="label">Total Flow:</span>
                        <span class="value">${formatNumber(totalFlow)}</span>
                        <span class="count">(${totalConnections} connections)</span>
                    </div>
                    <div class="flow-details">
                        <span class="label">Inflow:</span>
                        <span class="value">${formatNumber(totalInflow)}</span>
                        <span class="label">Outflow:</span>
                        <span class="value">${formatNumber(totalOutflow)}</span>
                    </div>
                    <div class="net-flow">
                        <span class="label">Net Flow:</span>
                        <span class="value ${
                          totalInflow - totalOutflow >= 0
                            ? "positive"
                            : "negative"
                        }">
                            ${
                              totalInflow - totalOutflow >= 0 ? "+" : ""
                            }${formatNumber(totalInflow - totalOutflow)}
                        </span>
                    </div>
                </div>
            </div>`);
}

function createVisualization(
    lsoas_21,
    flowsMap,
    namesMap,
    areaFlowTotals,
    lsoa_connections,
    flows,
    msoa_21
) {
    const width = 1350;
    const height = 960;

    const svg = d3
        .select("#map")
        .append("svg")
        .attr("width", width)
        .attr("height", height);

    // 创建自定义投影
    const projection = d3.geoIdentity().reflectY(true).fitSize([width, height], {
        type: "FeatureCollection",
        features: lsoas_21,
    });

    path = d3.geoPath().projection(projection);

    const defaultColor = "#f0f0f7";

    // 预计算最大流量
    const maxTotalFlow = d3.max(flows.map((flow) => flow.od_size));

    // 创建颜色比例尺
    const color = d3
        .scaleSqrt()
        .interpolate(() => d3.interpolateBuPu)
        .domain([0, maxTotalFlow]);

    function updateVisualization(focusId, isSelected = false) {
        const connectionData = lsoa_connections.get(focusId);
        if (connectionData) {
            // 合并流入和流出数据
            const allFlows = new Map();

            // 添加流入数据
            connectionData.inflows.forEach((value, id) => {
                allFlows.set(id, {
                    flow: value,
                    type: "inflow",
                });
            });

            // 添加流出数据
            connectionData.outflows.forEach((value, id) => {
                if (allFlows.has(id)) {
                    // 如果已经有流入，添加到现有记录
                    allFlows.get(id).outflow = value;
                } else {
                    // 如果没有流入，创建新记录
                    allFlows.set(id, {
                        flow: value,
                        type: "outflow",
                    });
                }
            });

            // 获取所有流量值用于比例尺
            const flowValues = Array.from(allFlows.values()).map((d) => d.flow);
            const minFlow = d3.min(flowValues);
            const maxFlow = d3.max(flowValues);

            // 创建颜色插值器函数
            const colorInterpolator = (value) => {
                const logMapped = logTransform(value, minFlow, maxFlow);
                const colorValue = remap(logMapped, 0, 1, 0.2, 0.9);
                return d3.interpolateBuPu(colorValue);
            };

            // 创建新的颜色比例尺用于图例
            const legendScale = d3
                .scaleSequential()
                .domain([minFlow, maxFlow])
                .interpolator(colorInterpolator);

            // 更新图例
            d3.select("#legend").select("svg").remove();
            legend(legendScale, "Flow volume with selected LSOA", (d) =>
                d >= 1000 ? `${(d / 1000).toFixed(1)}k` : d.toFixed(0)
            );

            // 更新所有LSOA区域的颜色
            svg
                .select(".lsoas")
                .selectAll("path")
                .attr("fill", (d) => {
                    const areaId = d.properties.lsoa21cd;
                    if (areaId === focusId) return "#ffff00";

                    if (allFlows.has(areaId)) {
                        const flowData = allFlows.get(areaId);
                        // 使用相同的颜色插值器函数
                        return colorInterpolator(flowData.flow);
                    }
                    return defaultColor;
                });

            // 更新信息框
            updateLocationInfo({
                locationId: focusId,
                name: namesMap.get(focusId),
                totalInflow: connectionData.total_inflow,
                totalOutflow: connectionData.total_outflow,
                connectionData: connectionData,
                flowConnections: allFlows,
            });
        }
    }

    // 添加新的函数来显示两个区域之间的流量信息
    function updateConnectionInfo(selectedId, hoverId, lsoa_connections, namesMap) {
        const selectedData = lsoa_connections.get(selectedId);
        const hoverData = lsoa_connections.get(hoverId);

        // 获取两个区域之间的流量
        const outflowToHover = selectedData.outflows.get(hoverId) || 0;
        const inflowFromHover = selectedData.inflows.get(hoverId) || 0;

        // 格式化数字
        const formatNumber = (num) => {
            if (num >= 1000) {
                return `${(num / 1000).toFixed(1)}k`;
            }
            return num.toFixed(0);
        };

        d3.select("#location-info .info-content").html(`
            <div class="info-id">Selected: ${selectedId}</div>
            <div class="info-name">${namesMap.get(selectedId)}</div>
            <div class="connection-info">
                <div class="connected-area">
                    <div class="info-id">Connected to: ${hoverId}</div>
                    <div class="info-name">${namesMap.get(hoverId)}</div>
                </div>
                <div class="flow-details">
                    <div class="flow-item">
                        <span class="label">Outflow:</span>
                        <span class="value">${formatNumber(outflowToHover)}</span>
                    </div>
                    <div class="flow-item">
                        <span class="label">Inflow:</span>
                        <span class="value">${formatNumber(inflowFromHover)}</span>
                    </div>
                    <div class="net-flow">
                        <span class="label">Net Flow:</span>
                        <span class="value ${inflowFromHover - outflowToHover >= 0 ? "positive" : "negative"}">
                            ${inflowFromHover - outflowToHover >= 0 ? "+" : ""}${formatNumber(inflowFromHover - outflowToHover)}
                        </span>
                    </div>
                </div>
            </div>`);
    }

    // 绘制LSOA区域
    svg
        .append("g")
        .attr("class", "lsoas")
        .selectAll("path")
        .data(lsoas_21)
        .enter()
        .append("path")
        .attr("fill", (d) => {
            const total = areaFlowTotals.get(d.properties.lsoa21cd);
            return total ? color(total) : defaultColor;
        })
        .attr("d", path)
        .on("click", function(event, d) {
            const feature = d3.select(this).datum();
            const clickedId = feature.properties.lsoa21cd;

            // 从feature的geometry中直接获取坐标
            const coordinates = feature.geometry.coordinates[0];

            // 转换所有坐标点到WGS84
            const convertedCoords = coordinates.map(coord => convertToWGS84(coord[0], coord[1]));

            // 计算转换后的地理边界框
            const lats = convertedCoords.map(coord => coord[0]); // 纬度
            const lons = convertedCoords.map(coord => coord[1]); // 经度

            const geoBounds = {
                southwest: [
                    Math.min(...lats), // 最小纬度
                    Math.min(...lons) // 最小经度
                ],
                northeast: [
                    Math.max(...lats), // 最大纬度
                    Math.max(...lons) // 最大经度
                ]
            };

            // 获取SVG边界框
            const svgBounds = path.bounds(feature);

            // 创建包含边界框信息的对象
            const boundingInfo = {
                feature: feature,
                bounds: {
                    geoBounds: geoBounds,
                    svgBounds: {
                        topLeft: svgBounds[0],
                        bottomRight: svgBounds[1],
                        width: svgBounds[1][0] - svgBounds[0][0],
                        height: svgBounds[1][1] - svgBounds[0][1]
                    }
                }
            };

            if (selectedCounty === this) {
                // 取消选中，解除锁定
                selectedCounty = null;
                isLocked = false;
                d3.select(this).attr("stroke", null).attr("stroke-width", null).lower();
                updateVisualization(null);
                updateOSMView(null); // 隐藏OSM地图
            } else {
                // 选择新区域，启用锁定
                if (selectedCounty) {
                    d3.select(selectedCounty)
                        .attr("stroke", null)
                        .attr("stroke-width", null)
                        .lower();
                }
                selectedCounty = this;
                isLocked = true;
                d3.select(this).attr("stroke", "#000").attr("stroke-width", 2).raise();
                updateVisualization(clickedId, true);
                updateOSMView(boundingInfo); // 传递包含边界框信息的对象
            }
        })
        .on("mouseover", function(event, d) {
            // 防止事件冒泡，确保不会触发地图容器的事件
            event.stopPropagation();

            const feature = d3.select(this).datum();
            const locationId = feature.properties.lsoa21cd;

            if (isLocked) {
                // 在锁定状态下，显示与选中区域的连接信息
                if (this !== selectedCounty) {
                    const selectedFeature = d3.select(selectedCounty).datum();
                    const selectedId = selectedFeature.properties.lsoa21cd;
                    updateConnectionInfo(selectedId, locationId, lsoa_connections, namesMap);

                    // 高亮显示当前悬停的区域
                    d3.select(this)
                        .attr("stroke", "#000")
                        .attr("stroke-width", 1.5)
                        .raise();
                }
            } else if (this !== selectedCounty) {
                // 未锁定状态下的原有行为
                d3.select(this)
                    .attr("stroke", "#000")
                    .attr("stroke-width", 1.5)
                    .raise();

                updateVisualization(locationId, false);
            }
        })
        .on("mouseout", function(event, d) {
            // 防止事件冒泡，确保不会触发地图容器的事件
            event.stopPropagation();

            if (isLocked) {
                if (this !== selectedCounty) {
                    // 移除高亮显示
                    d3.select(this).attr("stroke", null).lower();

                    // 恢复显示选中区域的信息
                    const selectedFeature = d3.select(selectedCounty).datum();
                    const selectedId = selectedFeature.properties.lsoa21cd;
                    updateVisualization(selectedId, true);
                }
            } else if (!isLocked && this !== selectedCounty) {
                // 未锁定状态下的原有行为
                d3.select(this).attr("stroke", null).lower();

                if (selectedCounty) {
                    const feature = d3.select(selectedCounty).datum();
                    const selectedId = feature.properties.lsoa21cd;
                    updateVisualization(selectedId, true);
                } else {
                    updateVisualization(null);
                }
            }
        });

    // 绘制MSOA边界
    const msoaBoundaries = svg
        .append("g")
        .attr("class", "msoa-boundaries")
        .selectAll("path")
        .data(msoa_21.features)
        .enter()
        .append("path")
        .attr("fill", "none")
        .attr("stroke", "#000")
        .attr("stroke-width", 1.5)
        .attr("stroke-opacity", 0.8)
        .attr("d", path);

    // 添加控制MSOA边界显示的函数
    function toggleMSOABoundaries(visible) {
        svg.select(".msoa-boundaries")
            .style("display", visible ? "block" : "none");
    }

    // 将toggleMSOABoundaries函数添加到window对象，使其可以从外部访问
    window.toggleMSOABoundaries = toggleMSOABoundaries;

    // 在绘制LSOA区域代码后添加
    const mapContainer = d3.select("#map");
    mapContainer.on("dblclick", function(event) {
        // 不管是否有选中状态，都响应双击事件
        // 重置所有区域的颜色到初始状态
        svg.select(".lsoas")
            .selectAll("path")
            .attr("fill", (d) => {
                const total = areaFlowTotals.get(d.properties.lsoa21cd);
                return total ? color(total) : defaultColor;
            })
            .attr("stroke", null)
            .attr("stroke-width", null)
            .lower();

        // 重置选中状态
        selectedCounty = null;
        isLocked = false;

        // 重置信息面板
        updateLocationInfo(null);

        // 隐藏OSM地图
        updateOSMView(null);
    });
}

// 将 SIP_MEASURE 改为 let 以便可以修改
let SIP_MEASURE = 'SIP_bi'; // 默认使用自行车数据

// 修改 changeSIPMeasure 函数
async function changeSIPMeasure(measure) {
    if (['SIP_bi', 'SIP_pt', 'SIP_dr'].includes(measure)) {
        SIP_MEASURE = measure;
        
        // 清除现有的可视化
        d3.select("#map").select("svg").remove();
        d3.select("#legend").select("svg").remove();
        
        // 重新加载数据和可视化
        const { lsoas_21, flows, areaFlowTotals, lsoa_connections, msoa_21 } = await loadData();
        const flowsMap = new Map();
        flows.forEach((flow) => {
            if (!flowsMap.has(flow.source)) {
                flowsMap.set(flow.source, new Map());
            }
            flowsMap.get(flow.source).set(flow.target, flow.od_size);
        });

        // 创建名称 Map
        const namesMap = new Map(
            lsoas_21.map((d) => [d.properties.lsoa21cd, d.properties.LSOA21NM])
        );

        // 重新创建可视化
        createVisualization(
            lsoas_21,
            flowsMap,
            namesMap,
            areaFlowTotals,
            lsoa_connections,
            flows,
            msoa_21
        );
    }
}

// 修改 loadData 函数中的 SIP 数据处理部分
async function loadData() {
    // 载入 LSOA 地理数据
    const geojson = await d3.json("data/lsoa_london_2021.min.geojson");
    const lsoas_21 = geojson.features;

    // 加载 MSOA 地理数据
    const msoa_21 = await d3.json("data/lad_london_2021.geojson");

    // 修改：加载 SIP 数据
    const sip_data = await d3.json("data/SIP_camden_allmodes.json");
    
    // 转换 SIP 数据为 flows 格式，使用当前选择的度量
    const flows = sip_data.map(flow => ({
        source: flow.source,
        target: flow.target,
        od_size: flow[SIP_MEASURE] // 使用当前选择的度量
    }));

    // 创建区域流量总和的 Map
    const areaFlowTotals = new Map();

    // 初始化每个区域的流量总和为 0
    lsoas_21.forEach((lsoa) => {
        areaFlowTotals.set(lsoa.properties.lsoa21cd, 0);
    });

    // 创建LSOA关联关系的Map
    const lsoa_connections = new Map();
    lsoas_21.forEach((lsoa) => {
        lsoa_connections.set(lsoa.properties.lsoa21cd, {
            outflows: new Map(), // 流出到其他LSOA的流量
            inflows: new Map(), // 从其他LSOA流入的流量
            total_outflow: 0, // 总流出量
            total_inflow: 0, // 总流入量
        });
    });

    // 计算流量和关联关系
    flows.forEach((flow) => {
        const sourceId = flow.source;
        const targetId = flow.target;
        const flowSize = flow.od_size;

        // 更新总流量
        areaFlowTotals.set(
            sourceId,
            (areaFlowTotals.get(sourceId) || 0) + flowSize
        );

        // 更新源LSOA的流出数据
        if (lsoa_connections.has(sourceId)) {
            const sourceData = lsoa_connections.get(sourceId);
            sourceData.outflows.set(targetId, flowSize);
            sourceData.total_outflow += flowSize;
        }

        // 更新目标LSOA的流入数据
        if (lsoa_connections.has(targetId)) {
            const targetData = lsoa_connections.get(targetId);
            targetData.inflows.set(sourceId, flowSize);
            targetData.total_inflow += flowSize;
        }
    });

    return {
        lsoas_21,
        flows,
        areaFlowTotals,
        lsoa_connections,
        msoa_21,
    };
}

function initDraggable(element, handle) {
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    let xOffset = 0;
    let yOffset = 0;

    handle.addEventListener("mousedown", dragStart);
    document.addEventListener("mousemove", drag);
    document.addEventListener("mouseup", dragEnd);

    function dragStart(e) {
        initialX = e.clientX - xOffset;
        initialY = e.clientY - yOffset;

        if (e.target === handle) {
            isDragging = true;
        }
    }

    function drag(e) {
        if (isDragging) {
            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;

            xOffset = currentX;
            yOffset = currentY;

            setTranslate(currentX, currentY, element);
        }
    }

    function setTranslate(xPos, yPos, el) {
        el.style.transform = `translate(${xPos}px, ${yPos}px)`;
    }

    function dragEnd(e) {
        initialX = currentX;
        initialY = currentY;
        isDragging = false;
    }
}

function initDraggableElements() {
    const info = document.getElementById("location-info");
    const infoHeader = info.querySelector(".info-header");
    const osmContainer = document.getElementById("osm-map-container");
    const osmHeader = osmContainer.querySelector(".osm-header");

    // Modify the dragging logic to stay within sidebar bounds
    function initDraggable(element, handle) {
        let isDragging = false;
        let currentX;
        let currentY;
        let initialX;
        let initialY;
        let xOffset = 0;
        let yOffset = 0;

        handle.addEventListener("mousedown", dragStart);
        document.addEventListener("mousemove", drag);
        document.addEventListener("mouseup", dragEnd);

        function dragStart(e) {
            initialX = e.clientX - xOffset;
            initialY = e.clientY - yOffset;

            if (e.target === handle) {
                isDragging = true;
            }
        }

        function drag(e) {
            if (isDragging) {
                e.preventDefault();

                const sidebar = document.querySelector('.sidebar');
                const sidebarRect = sidebar.getBoundingClientRect();
                const elementRect = element.getBoundingClientRect();

                currentX = e.clientX - initialX;
                currentY = e.clientY - initialY;

                // Constrain movement within sidebar
                currentX = Math.max(0, Math.min(currentX, sidebarRect.width - elementRect.width));
                currentY = Math.max(0, Math.min(currentY, sidebarRect.height - elementRect.height));

                xOffset = currentX;
                yOffset = currentY;

                setTranslate(currentX, currentY, element);
            }
        }

        function setTranslate(xPos, yPos, el) {
            el.style.transform = `translate(${xPos}px, ${yPos}px)`;
        }

        function dragEnd() {
            initialX = currentX;
            initialY = currentY;
            isDragging = false;
        }
    }

    initDraggable(info, infoHeader);
    initDraggable(osmContainer, osmHeader);
}

// 在 initOSMMap 函数中初始化OSM地图
function initOSMMap() {
    // 如果地图已存在，先移除
    if (osmMap) {
        osmMap.remove();
    }

    // 创建地图实例
    osmMap = L.map('osm-map', {
        zoomControl: false, // 禁用默认缩放控件
        attributionControl: false // 禁用归属信息
    });

    // 添加OSM图层
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19
    }).addTo(osmMap);

    // 初始化时隐藏地图容器
    document.getElementById('osm-map-container').style.display = 'none';
}

// 添加更新OSM地图视图的函数
function updateOSMView(boundingInfo) {
    if (!boundingInfo) {
        document.getElementById('osm-map-container').style.display = 'none';
        return;
    }

    try {
        // 显示地图容器
        const container = document.getElementById('osm-map-container');
        container.style.display = 'block';

        // 确保地图实例存在
        if (!osmMap) {
            initOSMMap();
        }

        const { southwest, northeast } = boundingInfo.bounds.geoBounds;

        // 创建 Leaflet 边界
        const leafletBounds = L.latLngBounds(southwest, northeast);

        // 计算边界框的中心点
        const center = leafletBounds.getCenter();

        // 计算适当的缩放级别
        // 根据边界框的大小来确定缩放级别
        const latDiff = Math.abs(northeast[0] - southwest[0]);
        const lonDiff = Math.abs(northeast[1] - southwest[1]);
        const maxDiff = Math.max(latDiff, lonDiff);

        // 根据边界框大小计算合适的缩放级别
        // 这个公式可以根据需要调整
        let zoom = Math.floor(14 - Math.log2(maxDiff * 111)); // 111km 是每度纬度的近似距离
        zoom = Math.min(Math.max(zoom, 12), 16); // 限制缩放级别在12-16之间

        // 设置地图视图
        setTimeout(() => {
            osmMap.invalidateSize();

            // 首先设置中心点和缩放级别
            osmMap.setView(center, zoom, {
                animate: false
            });

            // 然后确保边界框完全可见
            osmMap.fitBounds(leafletBounds, {
                padding: [50, 50], // 增加padding以确保边界完全可见
                maxZoom: zoom, // 使用计算出的缩放级别
                animate: true
            });

            // 添加边界框矩形
            if (window.currentBoundingBox) {
                osmMap.removeLayer(window.currentBoundingBox);
            }
            window.currentBoundingBox = L.rectangle(leafletBounds, {
                color: "#ff0000",
                weight: 1,
                fillOpacity: 0.1
            }).addTo(osmMap);

            // console.log("OSM View updated with bounds:", boundingInfo.bounds);
        }, 100);

    } catch (error) {
        console.error("Error updating OSM view:", error);
    }
}

function initSidebar() {
    const sidebar = document.createElement('div');
    sidebar.className = 'sidebar';

    // 添加操作说明框
    const instructions = document.createElement('div');
    instructions.className = 'instructions';
    instructions.innerHTML = `
        <div class="instructions-header">Instructions</div>
        <div class="instructions-content">
            <ul>
                <li>Hover over an area to view its details</li>
                <li><span class="key-instruction">Left Click</span> Select an area to view its flow relationships</li>
                <li>After selecting an area, hover over other areas to see flow relationships between them</li>
                <li><span class="key-instruction">Double Click</span> Deselect the current area and reset the view</li>
            </ul>
        </div>
    `;

    // 添加MSOA控制开关
    const msoaControl = document.createElement('div');
    msoaControl.className = 'msoa-control';
    msoaControl.innerHTML = `
        <div class="msoa-control-header">Map Settings</div>
        <div class="msoa-control-content">
            <div class="control-item">
                <label class="toggle-switch">
                    <input type="checkbox" id="msoa-toggle" checked>
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">Show MSOA Boundaries</span>
                </label>
            </div>
        </div>
    `;

    // 更新 SIP 度量选择控件
    const sipControl = document.createElement('div');
    sipControl.className = 'sip-control';
    sipControl.innerHTML = `
        <div class="sip-control-header">Transport Mode</div>
        <div class="sip-control-content">
            <div class="control-item">
                <select id="sip-measure">
                    <option value="SIP_bi">Bicycle</option>
                    <option value="SIP_pt">Public Transport</option>
                    <option value="SIP_dr">Driving</option>
                </select>
            </div>
            <div class="mode-description">
                <span id="mode-description">Current mode: Bicycle</span>
            </div>
        </div>
    `;

    sidebar.appendChild(instructions);
    sidebar.appendChild(msoaControl);
    sidebar.appendChild(sipControl);

    // Move existing elements into sidebar
    const locationInfo = document.getElementById('location-info');
    const osmContainer = document.getElementById('osm-map-container');
    sidebar.appendChild(locationInfo);
    sidebar.appendChild(osmContainer);

    document.body.appendChild(sidebar);

    // 添加MSOA开关事件监听器
    const msoaToggle = document.getElementById('msoa-toggle');
    msoaToggle.addEventListener('change', (e) => {
        if (window.toggleMSOABoundaries) {
            window.toggleMSOABoundaries(e.target.checked);
        }
    });

    // 更新 SIP 度量选择的事件监听器
    document.getElementById('sip-measure').addEventListener('change', async (e) => {
        const descriptions = {
            'SIP_bi': 'Bicycle',
            'SIP_pt': 'Public Transport',
            'SIP_dr': 'Driving'
        };
        
        document.getElementById('mode-description').textContent = 
            `Current mode: ${descriptions[e.target.value]}`;
            
        await changeSIPMeasure(e.target.value);
    });

    // Initialize sidebar resizing
    let isResizing = false;
    let lastDownX = 0;

    msoaControl.addEventListener('mousedown', (e) => {
        isResizing = true;
        lastDownX = e.clientX;
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        const delta = e.clientX - lastDownX;
        lastDownX = e.clientX;

        const newWidth = sidebar.offsetWidth + delta;
        if (newWidth > 300 && newWidth < window.innerWidth * 0.5) {
            sidebar.style.width = `${newWidth}px`;
            const map = document.getElementById('map');
            map.style.left = `${newWidth}px`;
            map.style.width = `calc(100% - ${newWidth}px)`;
        }
    });

    document.addEventListener('mouseup', () => {
        isResizing = false;
    });

    // Initialize sidebar toggle
    const toggleBtn = document.querySelector('.sidebar-toggle');
    toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        const map = document.getElementById('map');
        map.classList.toggle('sidebar-collapsed');

        // Trigger map resize event for proper rendering
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
            if (osmMap) {
                osmMap.invalidateSize();
            }
        }, 300);
    });
}

async function init() {
    const { lsoas_21, flows, areaFlowTotals, lsoa_connections, msoa_21 } =
    await loadData();

    // 创建流动数据的 Map
    const flowsMap = new Map();
    flows.forEach((flow) => {
        if (!flowsMap.has(flow.source)) {
            flowsMap.set(flow.source, new Map());
        }
        flowsMap.get(flow.source).set(flow.target, flow.od_size);
    });

    // 创建名称 Map
    const namesMap = new Map(
        lsoas_21.map((d) => [d.properties.lsoa21cd, d.properties.LSOA21NM])
    );

    // 修改可视化函数调用，添 flows 参数
    createVisualization(
        lsoas_21,
        flowsMap,
        namesMap,
        areaFlowTotals,
        lsoa_connections,
        flows,
        msoa_21
    );

    initDraggableElements();
    initSidebar();
    initOSMMap();
}

// 启动应用
init();