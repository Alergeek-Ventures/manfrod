defmodule ManfrodWeb.Layouts do
  @moduledoc """
  Layout components for the application.
  """
  use Phoenix.Component

  @doc """
  The root layout - outermost HTML wrapper.
  """
  def root(assigns) do
    ~H"""
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="csrf-token" content={Phoenix.Controller.get_csrf_token()} />
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🤵</text></svg>" />
        <title>Manfrod</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link href="https://fonts.googleapis.com/css2?family=Overpass+Mono:wght@400;600&display=swap" rel="stylesheet" />
        <link phx-track-static rel="stylesheet" href="/assets/app.css" />
        <script src="/assets/phoenix/phoenix.min.js">
        </script>
        <script src="/assets/lv/phoenix_live_view.min.js">
        </script>
        <script src="https://unpkg.com/cytoscape@3.33.1/dist/cytoscape.min.js">
        </script>
        <script>
          // Cytoscape Graph Hook for LiveView
          const CytoscapeGraph = {
            mounted() {
              const graphData = JSON.parse(this.el.dataset.graph || '{"nodes":[],"edges":[]}');
              const soulId = this.el.dataset.soulId;
              
              // Transform data for Cytoscape format
              const elements = [
                ...graphData.nodes.map(n => ({
                  data: { 
                    id: n.id, 
                    label: n.content_preview,
                    content: n.content,
                    processed: n.processed,
                    link_count: n.link_count,
                    inserted_at: n.inserted_at
                  }
                })),
                ...graphData.edges.map(e => ({
                  data: { 
                    id: e.source + '-' + e.target,
                    source: e.source, 
                    target: e.target 
                  }
                }))
              ];
              
              this.cy = cytoscape({
                container: this.el,
                elements: elements,
                style: [
                  {
                    selector: 'node',
                    style: {
                      'label': 'data(label)',
                      'text-wrap': 'ellipsis',
                      'text-max-width': '100px',
                      'font-size': '10px',
                      'color': '#a1a1aa',
                      'text-valign': 'bottom',
                      'text-margin-y': '5px',
                      'background-color': '#2dd4bf',
                      'width': 'mapData(link_count, 0, 20, 20, 50)',
                      'height': 'mapData(link_count, 0, 20, 20, 50)'
                    }
                  },
                  {
                    selector: 'node[!processed]',
                    style: {
                      'background-color': '#fbbf24'
                    }
                  },
                  {
                    selector: 'node:selected',
                    style: {
                      'border-color': '#3b82f6',
                      'border-width': 3
                    }
                  },
                  {
                    selector: 'node.highlighted',
                    style: {
                      'border-color': '#f472b6',
                      'border-width': 3
                    }
                  },
                  {
                    selector: 'edge',
                    style: {
                      'line-color': '#52525b',
                      'width': 1,
                      'curve-style': 'bezier'
                    }
                  }
                ],
                layout: {
                  name: 'cose',
                  animate: false,
                  nodeRepulsion: 8000,
                  idealEdgeLength: 100,
                  gravity: 0.25
                },
                minZoom: 0.1,
                maxZoom: 3
              });
              
              // Center on soul node if exists
              if (soulId) {
                const soulNode = this.cy.getElementById(soulId);
                if (soulNode.length > 0) {
                  this.cy.center(soulNode);
                  soulNode.select();
                }
              }
              
              // Node click handler
              this.cy.on('tap', 'node', (evt) => {
                const node = evt.target;
                this.pushEvent('node_clicked', { id: node.id() });
              });
              
              // Click on background deselects
              this.cy.on('tap', (evt) => {
                if (evt.target === this.cy) {
                  this.pushEvent('node_deselected', {});
                }
              });
              
              // Handle highlight_nodes event from LiveView
              this.handleEvent('highlight_nodes', ({ ids, center_on }) => {
                // Clear previous highlights
                this.cy.nodes().removeClass('highlighted');
                
                // Highlight matching nodes
                ids.forEach(id => {
                  this.cy.getElementById(id).addClass('highlighted');
                });
                
                // Center on first match
                if (center_on) {
                  const centerNode = this.cy.getElementById(center_on);
                  if (centerNode.length > 0) {
                    this.cy.animate({
                      center: { eles: centerNode },
                      zoom: 1.5,
                      duration: 300
                    });
                    centerNode.select();
                  }
                }
              });
              
              // Handle clear_highlight event
              this.handleEvent('clear_highlight', () => {
                this.cy.nodes().removeClass('highlighted');
              });
              
              // Handle update_graph event for filter changes
              this.handleEvent('update_graph', ({ nodes, edges }) => {
                const elements = [
                  ...nodes.map(n => ({
                    data: { 
                      id: n.id, 
                      label: n.content_preview,
                      content: n.content,
                      processed: n.processed,
                      link_count: n.link_count,
                      inserted_at: n.inserted_at
                    }
                  })),
                  ...edges.map(e => ({
                    data: { 
                      id: e.source + '-' + e.target,
                      source: e.source, 
                      target: e.target 
                    }
                  }))
                ];
                
                this.cy.json({ elements });
                this.cy.layout({
                  name: 'cose',
                  animate: true,
                  animationDuration: 500,
                  nodeRepulsion: 8000,
                  idealEdgeLength: 100,
                  gravity: 0.25
                }).run();
              });
            },
            
            destroyed() {
              if (this.cy) {
                this.cy.destroy();
              }
            }
          };

          let csrfToken = document.querySelector("meta[name='csrf-token']").getAttribute("content");
          let liveSocket = new LiveView.LiveSocket("/live", Phoenix.Socket, {
            params: { _csrf_token: csrfToken },
            hooks: { CytoscapeGraph }
          });
          liveSocket.connect();
        </script>
      </head>
      <body class="bg-zinc-900 text-zinc-200 antialiased">
        {@inner_content}
      </body>
    </html>
    """
  end

  @doc """
  The app layout - wraps page content.
  """
  attr :flash, :map, default: %{}
  attr :current_scope, :any, default: nil
  attr :class, :string, default: nil
  slot :inner_block, required: true

  def app(assigns) do
    ~H"""
    <main class={@class}>
      {render_slot(@inner_block)}
    </main>
    """
  end

  @doc """
  Navigation bar component.
  """
  attr :current, :atom, required: true

  def nav(assigns) do
    ~H"""
    <nav class="flex justify-center items-center gap-4 w-full font-mono px-2 py-4">
      <.nav_link href="/" label="activity" current={@current == :activity} />
      <.nav_link href="/retrospection" label="retrospection" current={@current == :retrospection} />
      <.nav_link href="/dashboard" label="dashboard" current={@current == :dashboard} />
      <.nav_link href="/graph" label="graph" current={@current == :graph} />
      <.nav_link href="/admin/access" label="admin" current={@current == :admin} />
    </nav>
    """
  end

  defp nav_link(assigns) do
    ~H"""
    <%= if @current do %>
      <span class="text-blue-400 decoration-solid"><%= @label %></span>
    <% else %>
      <.link navigate={@href} class="text-zinc-500 hover:text-zinc-300
      transition-colors"><%= @label %></.link>
    <% end %>
    """
  end
end
